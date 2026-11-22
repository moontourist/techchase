export const RULESET = { name: 'MeleeConchRuleset', repo: 'github.com/CarVac/MeleeConchRuleset', commit: '0ffc24d', date: '2025-12-09' };

export const REACH = { min: 90, max: 110 };
export const SHIELD = 43;
export const LIGHTSHIELD = 49;
export const MELEE_CAP = 140;
export const NOTCH_LIMITS = {
  diagonal: { stretch: 1.3, compress: 1 - 0.231 },
  modder: { stretch: 2, compress: 0.5 },
};
export const RESCUE_ANGLE = Math.atan2(0.325, 0.9375);
export const DEADZONE_RIM_ANGLE = Math.asin(0.2875);

const BIN_DEG = 5;
const BINS = 360 / BIN_DEG;
const COVER_RADIUS = 60;
const REST_RADIUS = 15;
const DIR_NAMES = ['right', 'up-right', 'up', 'up-left', 'left', 'down-left', 'down', 'down-right'];

const degOf = (x, y) => ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
const binOf = (x, y) => Math.round(degOf(x, y) / BIN_DEG) % BINS;
export const directionName = (deg) => DIR_NAMES[Math.round(deg / 45) % 8];

export function createRestMeter({ windowMs = 500, spread = 2 } = {}) {
  let samples = [];
  let rest = null;
  return {
    feed(s) {
      if (rest) return;
      if (s.buttons > 0) { samples = []; return; }
      samples.push(s);
      while (samples.length && s.t - samples[0].t > windowMs) samples.shift();
      if (s.t - samples[0].t < windowMs * 0.9) return;
      const keys = ['mx', 'my', 'cx', 'cy', 'l', 'r'];
      const still = keys.every((k) => {
        const v = samples.map((p) => p[k]);
        return Math.max(...v) - Math.min(...v) <= spread;
      });
      if (!still) return;
      rest = Object.fromEntries(keys.map((k) => [k, Math.round(samples.reduce((a, p) => a + p[k], 0) / samples.length)]));
    },
    get rest() { return rest; },
  };
}

export function createReachMeter() {
  const far = new Array(BINS).fill(0);
  let leftRest = false;
  let done = false;
  const api = {
    feed(x, y) {
      const r = Math.hypot(x, y);
      if (r >= REST_RADIUS) {
        const b = binOf(x, y);
        if (r > far[b]) far[b] = r;
        leftRest = true;
      } else if (leftRest && api.coverage === 1) {
        done = true;
      }
    },
    get coverage() { return far.filter((r) => r >= COVER_RADIUS).length / BINS; },
    get done() { return done; },
    get farthest() {
      let b = 0;
      for (let i = 1; i < BINS; i++) if (far[i] > far[b]) b = i;
      return { r: far[b], deg: b * BIN_DEG };
    },
    directions() {
      return DIR_NAMES.map((name, k) => {
        const c = (k * 45) / BIN_DEG;
        const r = Math.max(far[(c - 1 + BINS) % BINS], far[c], far[(c + 1) % BINS]);
        return { name, r };
      });
    },
  };
  return api;
}

export function reachResult(meter) {
  if (!meter || meter.coverage < 1) return null;
  const dirs = meter.directions();
  const far = meter.farthest;
  const low = dirs.reduce((a, d) => (d.r < a.r ? d : a));
  return { dirs, far: { r: far.r, name: directionName(far.deg), deg: far.deg }, low };
}

export function createTriggerMeter({ releaseMs = 300, restSlack = 3 } = {}) {
  let rest = 0;
  let active = false;
  let quietSince = null;
  let done = false;
  const counts = new Map();
  let samples = 0;
  let digital = false;
  let max = 0;
  return {
    setRest(v) { rest = v; },
    feed({ t, analog, digital: dig }) {
      if (done) return;
      const pressed = dig || analog > rest + restSlack;
      if (pressed) {
        active = true;
        quietSince = null;
        if (dig) digital = true;
        if (analog > rest + restSlack) {
          counts.set(analog, (counts.get(analog) ?? 0) + 1);
          samples++;
          if (analog > max) max = analog;
        }
        return;
      }
      if (!active) return;
      quietSince ??= t;
      if (t - quietSince >= releaseMs) done = true;
    },
    get active() { return active; },
    get done() { return done; },
    get max() { return max; },
    result() {
      if (!active) return null;
      if (!samples) return { kind: digital ? 'digital' : 'none', max: 0, digital };
      let top = 0;
      let topCount = 0;
      for (const [v, n] of counts) if (n > topCount) { top = v; topCount = n; }
      const others = samples - topCount;
      if (others <= 3 && others <= samples * 0.03) return { kind: 'fixed', value: top, max, digital };
      return { kind: 'analog', max, digital };
    },
  };
}

const TAU = 2 * Math.PI;
const span = (from, to) => ((to - from) % TAU + TAU) % TAU;

export function notchAngleCheck(measured, remapped) {
  const out = [];
  const at = (a, i) => a[((i % 16) + 16) % 16];
  for (let i = 0; i < 16; i++) {
    if (i % 4 === 0) continue;
    const modder = i % 2 === 1;
    if (modder && (at(measured, i) === null || at(measured, i) === undefined)) continue;
    const step = modder ? 1 : 2;
    const lim = modder ? NOTCH_LIMITS.modder : NOTCH_LIMITS.diagonal;
    for (const side of [-1, 1]) {
      const j = i + side * step;
      const before = side < 0 ? span(at(measured, j), at(measured, i)) : span(at(measured, i), at(measured, j));
      const after = side < 0 ? span(at(remapped, j), at(remapped, i)) : span(at(remapped, i), at(remapped, j));
      const ratio = after / before;
      let ok = ratio <= lim.stretch + 1e-9 && ratio >= lim.compress - 1e-9;
      if (!ok && modder && j % 4 === 0 && ratio > 1 && before <= DEADZONE_RIM_ANGLE && after <= RESCUE_ANGLE + 1e-9) ok = true;
      out.push({ notch: i, neighbor: ((j % 16) + 16) % 16, before, after, ratio, ok });
    }
  }
  return { ok: out.every((c) => c.ok), checks: out };
}

const fmtR = (r) => r.toFixed(1);

function reachRow(stick, res) {
  const rule = `Stick reach, ${stick}`;
  const ref = `Calibrated sticks reach at least ${REACH.min} and at most ${REACH.max} units from the origin.`;
  if (!res) return { rule, ref, status: 'skip', text: 'Not measured.' };
  const range = `${fmtR(res.low.r)} to ${fmtR(res.far.r)} units`;
  if (res.far.r > REACH.max) return { rule, ref, status: 'fail', text: `Reaches ${fmtR(res.far.r)} units at ${res.far.name}, past ${REACH.max}.` };
  if (res.low.r < REACH.min) return { rule, ref, status: 'fail', text: `Reaches only ${fmtR(res.low.r)} units at ${res.low.name}; it needs ${REACH.min}.` };
  return { rule, ref, status: 'pass', text: `Reaches ${range} (farthest at ${res.far.name}).` };
}

function triggerRows(side, rest, res) {
  const restRef = 'A trigger at rest outputs 0.';
  const rows = [];
  if (rest === null || rest === undefined) rows.push({ rule: `${side} trigger at rest`, ref: restRef, status: 'skip', text: 'Not measured.' });
  else if (rest === 0) rows.push({ rule: `${side} trigger at rest`, ref: restRef, status: 'pass', text: 'Rests at 0.' });
  else if (rest < SHIELD) rows.push({ rule: `${side} trigger at rest`, ref: restRef, status: 'warn', text: `Rests at ${rest}, not 0. Melee ignores anything under ${SHIELD}, but the ruleset asks for 0.` });
  else rows.push({ rule: `${side} trigger at rest`, ref: restRef, status: 'fail', text: `Rests at ${rest}, which Melee reads as a shield.` });

  const ref = `A press that gives a fixed analog value can't give ${SHIELD} to 48 (better than Z's lightshield).`;
  const rule = `${side} trigger press`;
  if (!res || res.kind === 'none') rows.push({ rule, ref, status: 'skip', text: 'Not measured.' });
  else if (res.kind === 'digital') rows.push({ rule, ref, status: 'pass', text: 'Digital only: no analog value.' });
  else if (res.kind === 'fixed') {
    const bad = res.value >= SHIELD && res.value < LIGHTSHIELD;
    rows.push({
      rule, ref, status: bad ? 'fail' : 'pass',
      text: bad ? `A press gives exactly ${res.value}.` : `A press gives exactly ${res.value}${res.value === LIGHTSHIELD ? ", the same as Z's lightshield" : ''}.`,
    });
  } else {
    rows.push({ rule, ref, status: 'pass', text: `Analog, up to ${res.max}${res.max > MELEE_CAP ? ` (Melee stops at ${MELEE_CAP})` : ''}.` });
  }
  return rows;
}

export function buildReport({ phob = true, reach = {}, rest = null, triggers = {} } = {}) {
  const rows = [reachRow('main stick', reach.main), reachRow('c-stick', reach.c)];
  rows.push({
    rule: 'Notch angles',
    ref: "A diagonal's angle to each cardinal stretches at most 30% or compresses at most 23.1%; a modder notch at most 100% or 50%.",
    status: 'note',
    text: phob
      ? "Can't be measured through the adapter. PhobGCC 0.29 holds every notch to these limits when you calibrate."
      : "Can't be measured through the adapter: it needs the angles from before calibration.",
  });
  rows.push({
    rule: 'Stick filters',
    ref: 'Filters ignore every other input, never run ahead of the stick, and use no timers.',
    status: phob ? 'pass' : 'note',
    text: phob
      ? "By design: PhobGCC's snapback filter and waveshaping are named as allowed, and its smoothing is a simple low-pass."
      : 'Depends on the firmware.',
  });
  rows.push(...triggerRows('L', rest?.l, triggers.l), ...triggerRows('R', rest?.r, triggers.r));
  rows.push({
    rule: 'Trigger curve',
    ref: 'Trigger mappings are static and never go down as you press.',
    status: phob ? 'pass' : 'note',
    text: phob ? 'By design: each PhobGCC trigger mode is a fixed mapping.' : 'Depends on the firmware.',
  });
  rows.push({
    rule: 'Macros',
    ref: 'No delayed button outputs, except anti-misinput delays on Start and the D-pad.',
    status: phob ? 'pass' : 'note',
    text: phob ? "By design: PhobGCC has no macros. Its Start and D-pad lockouts are allowed." : 'Depends on the firmware.',
  });
  rows.push({
    rule: 'Source code',
    ref: "Non-Nintendo controllers have their source available for inspection, and players name their firmware if asked.",
    status: phob ? 'pass' : 'note',
    text: phob ? "PhobGCC's source is public. Name your version if a TO asks." : 'Make sure the source is available, and name the firmware if a TO asks.',
  });
  rows.push({
    rule: 'Digital controller rules',
    ref: 'Coordinate fuzzing, travel time, banned coordinates, SOCD and modifiers.',
    status: 'note',
    text: "Don't apply: these are for button-only controllers.",
  });
  return rows;
}

export function summary(rows) {
  const n = (s) => rows.filter((r) => r.status === s).length;
  if (n('fail')) return { status: 'fail', text: `${n('fail')} rule${n('fail') > 1 ? 's' : ''} failed.` };
  if (n('skip')) return { status: 'skip', text: 'Passed what was measured; some steps were skipped.' };
  if (n('warn')) return { status: 'warn', text: 'Passed, with a warning.' };
  return { status: 'pass', text: 'Passed everything the app can check.' };
}

export const STATUS_TEXT = { pass: 'pass', warn: 'warn', fail: 'FAIL', skip: 'skipped', note: 'note' };

export function reportText(rows, { date = new Date(), controller = 'PhobGCC' } = {}) {
  const s = summary(rows);
  const lines = [
    `techchase tournament check, ${date.toISOString().slice(0, 10)}`,
    `Controller: ${controller}, through a GameCube adapter`,
    `Ruleset: ${RULESET.repo} at ${RULESET.commit} (${RULESET.date})`,
    `Result: ${s.text}`,
    'A self-check, not a ruling. The TO decides.',
    '',
    ...rows.map((r) => `[${STATUS_TEXT[r.status]}] ${r.rule}: ${r.text}`),
  ];
  return lines.join('\n');
}
