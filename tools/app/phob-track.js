export const ORIGIN = 127.5;
export const MEASURE_ORDER = [0, 4, 8, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15];
export const ADJUST_ORDER = [2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15];
export const POINTS = 32;
const FREEZE_MIN = 240;
const MAX_STICK_ANGLE = 0.4886921906;
const TRIGGER_DOWN = 100;
const SIDE_WINDOW_MS = 800;
const PICKUP_MS = 400;
const RIM_MIN = 85;
const RIM_MAX = 120;
const CENTER_MAX = 4;
const MEASURE_TOLERANCE = 8;
const ADJUST_TOLERANCE = 20;
const SAFE_ON_MS = 3200;
const COMBO_WAIT_MS = 1500;
const COMBO_TO_FREEZE_MS = 600;
const PRESS_WINDOW_MS = 150;
const PUSHED = 30;
const HELD = 45;

const NAMES = ['right', 'between right and up-right', 'up-right', 'between up-right and up', 'up', 'between up and up-left', 'up-left',
  'between up-left and left', 'left', 'between left and down-left', 'down-left', 'between down-left and down', 'down',
  'between down and down-right', 'down-right', 'between down-right and right'];
const DIAGONAL_IDEAL = { 2: [56, 56], 6: [-56, 56], 10: [-56, -56], 14: [56, -56] };

export const notchName = (n) => NAMES[n];
export const idealOf = (n) => DIAGONAL_IDEAL[n] ?? null;
export const notchDeg = (n) => n * 22.5;
export const isTertiary = (n) => n % 2 === 1;

export function targetOf(n) {
  const a = (notchDeg(n) * Math.PI) / 180;
  const v = (c) => Math.trunc((100 * Math.atan2(Math.sin(MAX_STICK_ANGLE) * c, Math.cos(MAX_STICK_ANGLE))) / MAX_STICK_ANGLE + ORIGIN);
  return { x: v(Math.cos(a)), y: v(Math.sin(a)) };
}
const TARGETS = MEASURE_ORDER.map((n) => ({ n, ...targetOf(n) }));
const exactTarget = (s) => TARGETS.find((q) => Math.abs(q.x - s.x) <= 1 && Math.abs(q.y - s.y) <= 1) ?? null;

const angleGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const has = (b, ...names) => names.every((n) => b.has(n));

export function classify(x, y) {
  if (x >= FREEZE_MIN && y >= FREEZE_MIN) return { kind: 'freeze' };
  const dx = x - ORIGIN;
  const dy = y - ORIGIN;
  const d = Math.hypot(dx, dy);
  if (d <= CENTER_MAX) return { kind: 'center' };
  if (d >= RIM_MIN && d <= RIM_MAX) return { kind: 'rim', deg: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360 };
  return { kind: 'other' };
}

function nearest(deg, candidates, tolerance) {
  let best = null;
  for (const n of candidates) {
    const g = angleGap(deg, notchDeg(n));
    if (g <= tolerance && (!best || g < best.g)) best = { n, g };
  }
  return best ? best.n : null;
}

export function createPhobTracker({ eightNotches = true, stick: preferred = 'main' } = {}) {
  const t = {
    phase: 'ready',
    stick: null,
    safe: 'unknown',
    point: 0,
    rim: null,
    notch: null,
    adjusted: [],
    events: [],
    eightNotches,
  };
  let freezeAt = null;
  let freezeCombo = null;
  let lastCombo = null;
  let comboAt = null;
  let prev = null;
  let skipAsked = false;
  let lastButtons = new Set();
  let lastL = -Infinity;
  let lastR = -Infinity;
  let pickup = null;
  const history = [];

  const say = (kind, text) => t.events.push({ kind, text });

  const selfStick = (p) => (t.stick === 'main' ? p.self.main : p.self.c);
  const shownBy = (p) => (t.stick === 'main' ? p.raw.c : p.raw.main);

  function checkPress(now, wasCenter, rimNotch) {
    const ds = history.filter((h) => now - h.t <= PRESS_WINDOW_MS).map((h) => h.d);
    if (!ds.length) return;
    const expectHeld = !wasCenter && !(isTertiary(rimNotch) && t.eightNotches);
    if (expectHeld && Math.max(...ds) < HELD) {
      say('warn', `Point ${t.point + 1} looks wrong: the stick wasn't in the ${notchName(rimNotch)} notch. Press Z to redo it.`);
    }
    if (!expectHeld && Math.min(...ds) > PUSHED) {
      say('warn', `Point ${t.point + 1} looks wrong: the stick wasn't let go. Press Z to redo it.`);
    }
  }

  function enterNotch(n) {
    t.phase = 'notch';
    t.notch = n;
    if (!t.adjusted.includes(n)) t.adjusted.push(n);
  }

  function watchSides(p, now) {
    if (p.buttons.has('L') || (p.trig?.l ?? 0) >= TRIGGER_DOWN) lastL = now;
    if (p.buttons.has('R') || (p.trig?.r ?? 0) >= TRIGGER_DOWN) lastR = now;
  }

  function startMeasuring(stick, how) {
    t.stick = stick;
    t.safe = 'off';
    t.phase = 'measure';
    t.point = 0;
    say('ok', `Calibration started${how}.`);
  }

  function watchPickup(p, now) {
    const seen = [['main', exactTarget(p.raw.c)], ['c', exactTarget(p.raw.main)]].find(([, q]) => q);
    if (!seen) { pickup = null; return; }
    const [stick, q] = seen;
    if (!pickup || pickup.stick !== stick || pickup.n !== q.n) { pickup = { stick, n: q.n, since: now }; return; }
    if (now - pickup.since < PICKUP_MS) return;
    const k = MEASURE_ORDER.indexOf(q.n);
    startMeasuring(stick, ` (picked up at point ${2 * k + 2} of ${POINTS})`);
    t.rim = k;
    t.point = 2 * k + 1;
    prev = { key: `r${q.n}`, kind: 'rim', n: q.n };
    pickup = null;
  }

  function watchCombos(b, now) {
    if (has(b, 'A', 'X', 'Y', 'START')) { lastCombo = 'safe'; comboAt = now; }
    else if (has(b, 'A', 'X', 'Y', 'L')) { lastCombo = 'main'; comboAt = now; }
    else if (has(b, 'A', 'X', 'Y', 'R')) { lastCombo = 'c'; comboAt = now; }
  }

  function freezeEnded(now) {
    const freezeAt0 = freezeAt;
    const long = now - freezeAt;
    freezeAt = null;
    if (freezeCombo === 'safe') {
      t.safe = long >= SAFE_ON_MS ? 'on' : 'off';
      if (t.safe === 'off') say('ok', 'Safe mode is off.');
      else say('warn', 'That turned safe mode back on. Hold A + X + Y + Start again.');
    } else if (t.phase === 'ready' && long >= SAFE_ON_MS) {
      t.safe = 'on';
      say('warn', 'Safe mode is back on. Hold A + X + Y + Start again.');
    } else if (t.phase === 'ready') {
      const recentL = freezeAt0 - lastL < SIDE_WINDOW_MS;
      const recentR = freezeAt0 - lastR < SIDE_WINDOW_MS;
      const stick = freezeCombo === 'main' || freezeCombo === 'c' ? freezeCombo
        : recentL && !recentR ? 'main' : recentR && !recentL ? 'c' : preferred;
      startMeasuring(stick, '');
    }
    freezeCombo = null;
    comboAt = null;
    prev = null;
  }

  function measureStep(here, before, now) {
    if (here.kind === 'rim') {
      const k = MEASURE_ORDER.indexOf(here.n);
      const rimToRim = before?.kind === 'rim';
      if (rimToRim || (skipAsked && before?.kind === 'center')) {
        if (rimToRim && t.point === POINTS - 1) checkPress(now, false, before.n);
        say('ok', skipAsked && !rimToRim ? 'Skipped to fine-tuning, keeping the old points.' : 'All 32 points done.');
        skipAsked = false;
        enterNotch(here.n);
        return;
      }
      if (before?.kind === 'center') checkPress(now, true, null);
      if (t.rim !== null && k < t.rim) say('info', `Went back to ${notchName(here.n)}.`);
      t.rim = k;
      t.point = 2 * k + 1;
      return;
    }
    if (before?.kind === 'rim') {
      checkPress(now, false, before.n);
      t.point = 2 * (t.rim + 1);
    }
  }

  t.feed = (p) => {
    const now = p.t;
    const b = p.buttons;
    watchCombos(b, now);
    if (freezeAt === null) watchSides(p, now);

    const frozen = classify(p.raw.main.x, p.raw.main.y).kind === 'freeze' && classify(p.raw.c.x, p.raw.c.y).kind === 'freeze';
    if (frozen) {
      if (freezeAt === null) {
        freezeAt = now;
        freezeCombo = comboAt !== null && now - comboAt < COMBO_TO_FREEZE_MS ? lastCombo : null;
      }
      lastButtons = b;
      return t;
    }
    if (freezeAt !== null) freezeEnded(now);

    if (t.phase === 'ready') {
      watchPickup(p, now);
      if (t.phase !== 'ready') return t;
      if (comboAt !== null && (lastCombo === 'main' || lastCombo === 'c') && now - comboAt > COMBO_WAIT_MS) {
        t.safe = 'on';
        say('warn', 'Nothing happened: safe mode is still on. Hold A + X + Y + Start for a second first.');
        comboAt = null;
      }
      lastButtons = b;
      return t;
    }
    if (t.phase === 'done') return t;

    const self = selfStick(p);
    history.push({ t: now, d: Math.hypot(self.x, self.y) });
    while (history.length && now - history[0].t > 1000) history.shift();
    if (b.has('START') && !lastButtons.has('START') && t.phase === 'measure') skipAsked = true;
    lastButtons = b;

    const raw = shownBy(p);
    const shown = classify(raw.x, raw.y);
    let here = shown;
    if (shown.kind === 'rim') {
      const loose = t.phase === 'notch' || skipAsked || (t.rim === MEASURE_ORDER.length - 1 && prev?.kind === 'rim');
      const n = loose ? nearest(shown.deg, ADJUST_ORDER, ADJUST_TOLERANCE) : nearest(shown.deg, MEASURE_ORDER, MEASURE_TOLERANCE);
      if (n === null) return t;
      here = { kind: 'rim', n };
    }
    if (here.kind !== 'rim' && here.kind !== 'center') return t;
    const key = here.kind === 'rim' ? `r${here.n}` : 'center';
    if (prev?.key === key) return t;
    const before = prev;
    prev = { key, ...here };

    if (t.phase === 'measure') {
      measureStep(here, before, now);
    } else if (here.kind === 'center') {
      t.phase = 'done';
      t.notch = null;
      say('ok', 'Saved on the Phob.');
    } else {
      enterNotch(here.n);
    }
    return t;
  };

  t.nextEvents = () => t.events.splice(0);
  return t;
}

export function notchHint(n, melee, held) {
  const ideal = DIAGONAL_IDEAL[n];
  if (!ideal) return { kind: 'free' };
  if (!held) return { kind: 'hold' };
  const [mx, my] = melee;
  if (mx === ideal[0] && my === ideal[1]) return { kind: 'on' };
  const at = (Math.atan2(my, mx) * 180) / Math.PI;
  const want = (Math.atan2(ideal[1], ideal[0]) * 180) / Math.PI;
  const diff = ((at - want + 540) % 360) - 180;
  if (Math.abs(diff) < 0.01) return { kind: 'distance' };
  return { kind: diff > 0 ? 'cw' : 'ccw' };
}
