import {
  ADJUST_ORDER, MEASURE_ORDER, ORIGIN, POINTS, createPhobTracker, idealOf, isTertiary, notchDeg, notchHint, notchName, targetOf,
} from './phob-track.js';
import { fmtMelee, meleeUnits } from './melee.js';

const SVG = 'http://www.w3.org/2000/svg';
const HELD_RADIUS = 70;
const PIC_PER_UNIT = 46 / 100;
const PIC_MAX = 56;
const HELD_DEGREES = 15;
const LOG_MAX = 6;
const STEPS = [
  ['safe', 'Safe mode off'],
  ['start', 'Start'],
  ['measure', 'Measure'],
  ['notch', 'Fine-tune'],
  ['done', 'Done'],
];

const svgEl = (tag, attrs, parent) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
};
const melee = (m) => `${fmtMelee(m[0]).trim()}, ${fmtMelee(m[1]).trim()}`;

export function createPhobCalibration({ root, onDone }) {
  const $ = (s) => root.querySelector(s);
  const panel = $('#phobCalib');
  const pic = $('#phobPic');
  const dots = [];
  const rim = Array.from({ length: 16 }, (_, n) => {
    const q = targetOf(n);
    return [(q.x - ORIGIN) * PIC_PER_UNIT, -(q.y - ORIGIN) * PIC_PER_UNIT];
  });
  svgEl('polygon', { points: rim.filter((_, n) => n % 2 === 0).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '), class: 'gate' }, pic);
  for (let n = 0; n < 16; n++) {
    dots.push(svgEl('circle', { cx: rim[n][0].toFixed(1), cy: rim[n][1].toFixed(1), r: isTertiary(n) ? 3 : 5, class: 'notch' }, pic));
  }
  const center = svgEl('circle', { r: 5, class: 'notch' }, pic);
  const live = svgEl('circle', { r: 3.5, class: 'live' }, pic);

  let tracker = null;
  let wanted = 'main';
  let latest = null;
  let frame = 0;
  const log = [];

  const stickWord = () => ((tracker?.stick ?? wanted) === 'main' ? 'main stick' : 'c-stick');
  const comboKey = () => ((tracker?.stick ?? wanted) === 'main' ? 'L' : 'R');

  function stepOf() {
    if (!tracker) return 'safe';
    if (tracker.phase === 'ready') return tracker.safe === 'off' ? 'start' : 'safe';
    return tracker.phase;
  }

  function renderSteps() {
    const now = STEPS.findIndex(([k]) => k === stepOf());
    const list = $('#phobSteps');
    list.replaceChildren(...STEPS.map(([, text], i) => {
      const li = document.createElement('li');
      li.textContent = text;
      li.className = i < now ? 'done' : i === now ? 'now' : '';
      return li;
    }));
  }

  function paint(target, centerOn) {
    dots.forEach((d, n) => {
      const doneMeasure = tracker?.phase === 'measure' && MEASURE_ORDER.indexOf(n) < (tracker.rim ?? -1);
      const doneAdjust = tracker?.phase === 'notch' && tracker.adjusted.includes(n) && n !== target;
      d.setAttribute('class', `notch${doneMeasure || doneAdjust || tracker?.phase === 'done' ? ' done' : ''}${n === target ? ' target' : ''}`);
    });
    center.setAttribute('class', `notch${centerOn ? ' target' : ''}`);
  }

  function selfMelee() {
    if (!latest) return null;
    const g = latest.rep.game;
    const [x, y] = tracker?.stick === 'c' ? [g.rx, g.ry] : [g.lx, g.ly];
    const clamp = (v) => Math.max(-PIC_MAX, Math.min(PIC_MAX, v));
    live.setAttribute('cx', clamp(x * PIC_PER_UNIT).toFixed(1));
    live.setAttribute('cy', clamp(-y * PIC_PER_UNIT).toFixed(1));
    return { x, y, m: meleeUnits(x, y) };
  }

  function say(doText, why) {
    $('#phobDo').textContent = doText;
    $('#phobWhy').textContent = why;
  }

  function renderNotch(s) {
    const n = tracker.notch;
    const name = notchName(n);
    const active = ADJUST_ORDER.filter((k) => !isTertiary(k) || tracker.adjusted.includes(k) || !tracker.eightNotches);
    const k = tracker.adjusted.indexOf(n) + 1;
    paint(n, false);
    const deg = (Math.atan2(s.y, s.x) * 180) / Math.PI;
    const held = Math.hypot(s.x, s.y) >= HELD_RADIUS && Math.abs(((deg - notchDeg(n) + 540) % 360) - 180) <= HELD_DEGREES;
    const hint = notchHint(n, s.m, held);
    const reads = `It reads ${melee(s.m)}`;
    const goal = idealOf(n) ? melee(idealOf(n)) : '';
    const keys = 'Keep the stick in the notch while you tap. B undoes your taps on this notch, Z goes back one.';
    const inNotch = held || (isTertiary(n) && Math.hypot(s.x, s.y) >= HELD_RADIUS);
    const [doText, why] = {
      hold: [`Push the ${stickWord()} into the ${name} notch and keep it there.`, 'The app then shows which button to tap.'],
      on: ['Perfect. Press A for the next notch.', `${reads}, right on ${goal}.`],
      cw: ['Tap X.', `${reads}. The target is ${goal}. ${keys}`],
      ccw: ['Tap Y.', `${reads}. The target is ${goal}. ${keys}`],
      distance: ['Press A to keep it.', `${reads}. The direction is right, but this step can't change how far out it reaches. If that matters, calibrate again.`],
      free: inNotch
        ? ['Tap X or Y until it reads what you want, then press A.', `${reads}. X turns it clockwise, Y counterclockwise. ${keys}`]
        : [`Push the ${stickWord()} into the ${name} notch and keep it there.`, 'The app then shows what it reads.'],
    }[hint.kind];
    $('#phobTitle').textContent = `Fine-tune the ${name} notch (${k} of ${tracker.eightNotches ? 4 : active.length})`;
    say(doText, why);
  }

  function render() {
    frame = 0;
    if (!tracker || panel.hidden) return;
    for (const e of tracker.nextEvents()) {
      log.unshift(e);
      if (log.length > LOG_MAX) log.pop();
    }
    $('#phobLog').replaceChildren(...log.map((e) => {
      const li = document.createElement('li');
      li.textContent = e.text;
      li.className = e.kind;
      return li;
    }));
    renderSteps();
    const s = selfMelee();
    const t = tracker;
    $('#phobEightRow').hidden = t.phase === 'notch' || t.phase === 'done';
    if (t.phase === 'ready') {
      $('#phobTitle').textContent = `Calibrate the ${stickWord()}`;
      paint(null, false);
      if (t.safe === 'off') {
        say(`Press A + X + Y + ${comboKey()} together, then let go.`, 'The sticks jump to the top right for 2 seconds, then calibration starts.');
      } else {
        say('Turn off safe mode: hold A + X + Y + Start for 1 second.', `The sticks jump to the top right for 2 seconds when it works. Safe mode already off? Press A + X + Y + ${comboKey()} instead. Sticks not moving at all? Tap B first.`);
      }
      return;
    }
    if (t.phase === 'measure') {
      const shown = t.point % 2 === 1 ? MEASURE_ORDER[t.rim] : null;
      const point = `Point ${t.point + 1} of ${POINTS}.`;
      const undo = 'Made a mistake? Press Z to go back.';
      $('#phobTitle').textContent = `Measure the ${stickWord()} (${t.point + 1} of ${POINTS})`;
      if (shown === null) {
        paint(null, true);
        say('Let go of the stick. Press A.', `${point} This one is the center. ${undo}`);
      } else if (isTertiary(shown) && t.eightNotches) {
        paint(shown, false);
        say('Let go of the stick. Press A.', `${point} This spot (${notchName(shown)}) is for an extra notch your shell doesn't have, so it's skipped.`);
      } else if (isTertiary(shown)) {
        paint(shown, false);
        say(`Notch ${notchName(shown)}? Hold the stick in it. No notch there? Let go. Then press A.`, `${point} ${undo}`);
      } else {
        paint(shown, false);
        say(`Push the stick into the ${notchName(shown)} notch. Hold it there and press A.`, `${point} Slide in the way you would in a game. ${undo}`);
      }
      return;
    }
    if (t.phase === 'notch') {
      renderNotch(s ?? { x: 0, y: 0, m: [0, 0] });
      return;
    }
    paint(null, false);
    $('#phobTitle').textContent = 'Calibration done';
    say('Saved. Now turn safe mode back on: press A + X + Y + Start.', 'The sticks hold for 4 seconds when it works. Check each notch in the table below. Next time you plug the Phob in, tap B to wake the sticks.');
  }

  function schedule() { if (!frame) frame = requestAnimationFrame(render); }

  $('#phobClose').addEventListener('click', () => api.stop());
  $('#phobEight').addEventListener('change', (e) => { if (tracker) tracker.eightNotches = e.target.checked; schedule(); });

  const api = {
    get active() { return !!tracker && !panel.hidden; },
    start(which) {
      wanted = which;
      tracker = createPhobTracker({ eightNotches: $('#phobEight').checked, stick: which });
      log.length = 0;
      panel.hidden = false;
      schedule();
    },
    feed(p, rep) {
      if (!tracker) return;
      latest = { p, rep };
      const before = tracker.phase;
      tracker.feed({
        t: p.at,
        buttons: p.buttons,
        raw: { main: p.main, c: p.c },
        trig: { l: p.l, r: p.r },
        self: { main: { x: rep.game.lx, y: rep.game.ly }, c: { x: rep.game.rx, y: rep.game.ry } },
      });
      if (before !== 'done' && tracker.phase === 'done') onDone?.();
      schedule();
    },
    stop() {
      tracker = null;
      panel.hidden = true;
    },
  };
  return api;
}
