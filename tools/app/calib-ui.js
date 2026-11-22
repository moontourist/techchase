import { ID_READ_CONFIG_BLOCK } from './gcu-protocol.js';
import { NOTCHES } from './melee.js';
import {
  ANALOG_CMD, CENTER_STILL_COUNTS, CFG_BLOCK_ANALOG, StillDetector, angleOff, checkCapture, notchSlots, nudge,
  factoryDefaults, parseAnalog, readSlots, readTuning, tuningLooksBroken, withNewCenters, writeSlots, writeTuning,
} from './calibration.js';

const SVG = 'http://www.w3.org/2000/svg';
const POLL_MS = 25;
const CENTER_SETTLE_MS = 200;
const FAR_FROM_CENTER = 400;
const LEAVE_NOTCH_DEGREES = 10;
const NUDGE_DEGREES = 0.5;
const PIC_RADIUS = 50;
const RAW_RADIUS = 2048;
const NAMES = { l: 'main stick', r: 'c-stick' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}

const point = (angle, distance) => {
  const r = (Math.min(distance, RAW_RADIUS) / RAW_RADIUS) * PIC_RADIUS;
  const a = (angle * Math.PI) / 180;
  return [r * Math.cos(a), -r * Math.sin(a)];
};

export function createCalibration({ root, getDev, onChange, toast }) {
  const $ = (s) => root.querySelector(s);
  const panel = $('#calib');
  let run = 0;
  let side = null;
  let backup = null;
  let current = null;
  let captures = [];
  let step = 'idle';
  let pending = false;

  const pic = $('#calibPic');
  pic.replaceChildren();
  svg('polygon', { class: 'gate', points: NOTCHES.map((n) => point(n.deg, RAW_RADIUS * 0.92).join(',')).join(' ') }, pic);
  const dots = NOTCHES.map((n) => {
    const [x, y] = point(n.deg, RAW_RADIUS * 0.92);
    return svg('circle', { cx: x, cy: y, r: 4, class: 'notch' }, pic);
  });
  const live = svg('circle', { cx: 0, cy: 0, r: 3, class: 'live' }, pic);

  function setPending(v) {
    pending = v;
    onChange();
  }

  function show(title, text, msg = '') {
    $('#calibTitle').textContent = title;
    $('#calibStep').textContent = text;
    $('#calibMsg').textContent = msg;
  }

  function paint(target) {
    dots.forEach((d, i) => {
      d.setAttribute('class', `notch${captures[i] ? ' done' : ''}${i === target ? ' target' : ''}`);
    });
  }

  function moveLive(cap) {
    const [x, y] = point(cap.angle, cap.distance);
    live.setAttribute('cx', x.toFixed(1));
    live.setAttribute('cy', y.toFixed(1));
  }

  const captureCmd = () => (side === 'l' ? ANALOG_CMD.CAPTURE_LEFT : ANALOG_CMD.CAPTURE_RIGHT);
  const alive = (token) => token === run;

  async function waitCenter(token) {
    const dev = getDev();
    const detectors = { l: new StillDetector({ degrees: null, counts: CENTER_STILL_COUNTS }), r: new StillDetector({ degrees: null, counts: CENTER_STILL_COUNTS }) };
    const t0 = performance.now();
    while (alive(token)) {
      const now = performance.now();
      const l = await dev.captureStick(ANALOG_CMD.CAPTURE_LEFT);
      const r = await dev.captureStick(ANALOG_CMD.CAPTURE_RIGHT);
      if (!alive(token)) return false;
      moveLive(side === 'l' ? l : r);
      const sl = detectors.l.feed(l, now);
      const sr = detectors.r.feed(r, now);
      const far = Math.max(l.distance, r.distance) > FAR_FROM_CENTER;
      if (sl && sr && !far) return true;
      if (now - t0 > 2000 && far) $('#calibMsg').textContent = 'A stick reads far from its center. Let go of both sticks completely.';
      await sleep(POLL_MS);
    }
    return false;
  }

  async function captureCenter(token) {
    const dev = getDev();
    show(`Calibrating the ${NAMES[side]}`, 'Let go of both sticks and leave them still.', 'The center is measured once they settle.');
    paint(-1);
    if (!(await waitCenter(token))) return false;
    current = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
    await dev.configCommand(CFG_BLOCK_ANALOG, ANALOG_CMD.CALIBRATE_START);
    await sleep(CENTER_SETTLE_MS);
    await dev.configCommand(CFG_BLOCK_ANALOG, ANALOG_CMD.CALIBRATE_STOP);
    const fresh = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
    current = withNewCenters(current, fresh);
    await dev.writeBlock(CFG_BLOCK_ANALOG, current);
    setPending(true);
    return alive(token);
  }

  async function captureNotches(token) {
    const dev = getDev();
    const detector = new StillDetector();
    let shown = -1;
    for (;;) {
      const i = captures.findIndex((c) => !c);
      if (!alive(token) || i < 0) break;
      if (i !== shown) {
        detector.reset();
        shown = i;
      }
      paint(i);
      show(`Calibrating the ${NAMES[side]}`, `Push into the ${NOTCHES[i].name.toLowerCase()} notch and hold it there.`,
        `Notch ${i + 1} of 8. It's taken after a quarter second without moving.`);
      const now = performance.now();
      const cap = await dev.captureStick(captureCmd());
      if (!alive(token)) return false;
      moveLive(cap);
      const prev = i > 0 ? captures[i - 1] : null;
      const stillInPrev = prev && cap.distance > FAR_FROM_CENTER && angleOff(cap.angle, prev.angle) < LEAVE_NOTCH_DEGREES;
      const held = stillInPrev ? (detector.reset(), null) : detector.feed(cap, now);
      if (held) {
        const err = checkCapture(i, held);
        if (err) {
          $('#calibMsg').textContent = `${err[0].toUpperCase()}${err.slice(1)}.`;
          detector.reset();
        } else {
          captures[i] = held;
          detector.reset();
        }
      }
      await sleep(POLL_MS);
    }
    return alive(token);
  }

  async function apply() {
    const slots = notchSlots(readSlots(current, side), captures);
    current = writeSlots(current, side, slots);
    await getDev().writeBlock(CFG_BLOCK_ANALOG, current);
  }

  function renderCheck() {
    step = 'check';
    paint(-1);
    show(`The ${NAMES[side]} is calibrated`, 'Check it with the notch check below: push into each notch and compare with the targets.',
      'A notch that reads off can be turned here, half a degree at a time. Then press Save to controller.');
    const rows = $('#calibRows');
    rows.replaceChildren();
    const slots = readSlots(current, side);
    NOTCHES.forEach((n, i) => {
      const row = document.createElement('div');
      row.className = 'calib-row';
      const label = document.createElement('span');
      label.textContent = `${n.name} notch at ${slots[i].inAngle.toFixed(1)}°`;
      const turn = (deg, text) => {
        const b = document.createElement('button');
        b.className = 'ghost small-btn';
        b.textContent = text;
        b.setAttribute('aria-label', `${n.name}: turn ${deg > 0 ? 'counterclockwise' : 'clockwise'}`);
        b.addEventListener('click', async () => {
          try {
            current = writeSlots(current, side, nudge(readSlots(current, side), i, deg));
            await getDev().writeBlock(CFG_BLOCK_ANALOG, current);
            renderCheck();
          } catch (e) {
            toast(`Turning the notch failed: ${e.message || e}`, 'error');
          }
        });
        return b;
      };
      row.append(turn(-NUDGE_DEGREES, '↻'), label, turn(NUDGE_DEGREES, '↺'));
      rows.append(row);
    });
    $('#calibDone').hidden = false;
    $('#calibBack').hidden = true;
  }

  async function start(which) {
    const token = ++run;
    side = which;
    captures = Array(8).fill(null);
    step = 'center';
    panel.hidden = false;
    $('#calibRows').replaceChildren();
    $('#calibDone').hidden = true;
    $('#calibBack').hidden = false;
    try {
      const dev = getDev();
      if (!backup) backup = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
      if (!(await captureCenter(token))) return;
      step = 'notches';
      if (!(await captureNotches(token))) return;
      await apply();
      if (alive(token)) renderCheck();
    } catch (e) {
      if (!alive(token)) return;
      toast(`Calibration stopped: ${e.message || e}`, 'error');
      await cancel();
    }
  }

  async function reset() {
    const token = ++run;
    side = 'l';
    step = 'center';
    panel.hidden = false;
    $('#calibRows').replaceChildren();
    $('#calibDone').hidden = true;
    $('#calibBack').hidden = true;
    try {
      const dev = getDev();
      if (!backup) backup = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
      show('Resetting both sticks', 'Let go of both sticks and leave them still.', 'Their centers are measured again once they settle.');
      paint(-1);
      if (!(await waitCenter(token))) return;
      const before = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
      await dev.configCommand(CFG_BLOCK_ANALOG, ANALOG_CMD.CALIBRATE_START);
      await sleep(CENTER_SETTLE_MS);
      await dev.configCommand(CFG_BLOCK_ANALOG, ANALOG_CMD.CALIBRATE_STOP);
      const fresh = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
      current = factoryDefaults(before, fresh);
      await dev.writeBlock(CFG_BLOCK_ANALOG, current);
      setPending(true);
      if (!alive(token)) return;
      run++;
      step = 'idle';
      panel.hidden = true;
      toast('Both sticks are back to the factory settings. Try them, then Save to controller, or Discard to undo.', 'ok');
      refreshHint();
    } catch (e) {
      if (!alive(token)) return;
      toast(`Reset stopped: ${e.message || e}`, 'error');
      await cancel();
    }
  }

  async function restoreBackup() {
    if (!backup) return;
    await getDev().writeBlock(CFG_BLOCK_ANALOG, backup);
    backup = null;
    current = null;
    setPending(false);
  }

  async function cancel() {
    run++;
    panel.hidden = true;
    step = 'idle';
    try {
      await restoreBackup();
      toast('Calibration cancelled. The sticks are back to how they were.', 'ok');
    } catch (e) {
      toast(`Couldn't restore the old calibration: ${e.message || e}. Unplug the controller to get the saved one back.`, 'error');
    }
  }

  $('#calibBack').addEventListener('click', () => {
    if (step !== 'notches') return;
    const last = captures.map((c, i) => (c ? i : -1)).filter((i) => i >= 0).pop();
    if (last !== undefined) captures[last] = null;
  });
  $('#calibCancel').addEventListener('click', () => cancel());
  $('#calibDone').addEventListener('click', () => {
    run++;
    step = 'idle';
    panel.hidden = true;
  });

  async function refreshHint() {
    const hint = $('#calibHint');
    hint.textContent = '';
    try {
      const block = await getDev().readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
      const a = parseAnalog(block);
      if (tuningLooksBroken(block)) hint.textContent = 'These stick settings look damaged: reset the sticks to factory settings.';
      else if (!a.calibrationSet) hint.textContent = 'These sticks have never been calibrated: calibrate them (about a minute each), or leave the factory settings.';
    } catch {
      hint.textContent = '';
    }
  }

  return {
    start,
    reset,
    cancel,
    refreshHint,
    get pending() { return pending; },
    get step() { return step; },
    async discard() { await restoreBackup(); },
    async tuning(s) {
      return readTuning(await getDev().readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG), s);
    },
    async setTuning(s, patch) {
      if (step !== 'idle') throw new Error('finish the stick calibration first');
      const dev = getDev();
      const before = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
      if (!backup) backup = before;
      current = writeTuning(before, s, patch);
      await dev.writeBlock(CFG_BLOCK_ANALOG, current);
      setPending(true);
      return readTuning(current, s);
    },
    saved() { backup = null; setPending(false); },
    detach() {
      run++;
      panel.hidden = true;
      step = 'idle';
      backup = null;
      current = null;
      pending = false;
    },
  };
}
