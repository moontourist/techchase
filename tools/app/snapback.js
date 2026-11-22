export const DEADZONE = 23;
export const CLOSE = 16;
export const PUSHED = 64;
const RELEASE_MS = 60;
const WATCH_MS = 60;
const KEEP = 5;
export const ENOUGH = 3;

export const DIRECTIONS = [
  { key: 'right', axis: 'x', sign: 1, name: 'right' },
  { key: 'left', axis: 'x', sign: -1, name: 'left' },
  { key: 'up', axis: 'y', sign: 1, name: 'up' },
  { key: 'down', axis: 'y', sign: -1, name: 'down' },
];
const dirOf = (axis, sign) => DIRECTIONS.find((d) => d.axis === axis && d.sign === sign);

export const melee = (v) => (v / 80).toFixed(4);

export function verdict(bounce) {
  if (bounce === null) return 'none';
  if (bounce >= DEADZONE) return 'crosses';
  if (bounce >= CLOSE) return 'close';
  return 'ok';
}

export function createSnapbackMeter() {
  const axes = { x: { phase: 'idle' }, y: { phase: 'idle' } };
  const results = Object.fromEntries(DIRECTIONS.map((d) => [d.key, []]));
  let changed = 0;

  function feedAxis(name, v, pre, t) {
    const a = axes[name];
    if (Math.abs(v) >= PUSHED) {
      axes[name] = { phase: 'out', sign: Math.sign(v) };
      return;
    }
    if (a.phase === 'out') {
      axes[name] = { phase: 'falling', sign: a.sign, since: t };
      return;
    }
    if (a.phase === 'falling') {
      if (t - a.since > RELEASE_MS) { axes[name] = { phase: 'idle' }; return; }
      if (v * a.sign <= 0) axes[name] = { phase: 'watch', sign: a.sign, since: t, worst: -a.sign * v, worstPre: pre === null ? null : Math.max(0, -a.sign * pre) };
      return;
    }
    if (a.phase === 'watch') {
      a.worst = Math.max(a.worst, -a.sign * v);
      if (pre !== null) a.worstPre = Math.max(a.worstPre ?? 0, -a.sign * pre);
      if (t - a.since < WATCH_MS) return;
      const d = dirOf(name, a.sign);
      const list = results[d.key];
      list.push({ bounce: Math.max(0, a.worst), pre: a.worstPre, t });
      if (list.length > KEEP) list.shift();
      changed++;
      axes[name] = { phase: 'idle' };
    }
  }

  return {
    feed({ t, x, y, preX = null, preY = null }) {
      feedAxis('x', x, preX, t);
      feedAxis('y', y, preY, t);
    },
    get changed() { return changed; },
    results(key) { return results[key]; },
    worst(key) {
      const list = results[key];
      return list.length ? Math.max(...list.map((r) => r.bounce)) : null;
    },
    worstPre(key) {
      const list = results[key].filter((r) => r.pre !== null);
      return list.length ? Math.max(...list.map((r) => r.pre)) : null;
    },
    count(axis) { return DIRECTIONS.filter((d) => d.axis === axis).reduce((n, d) => n + results[d.key].length, 0); },
    worstAxis(axis) {
      const w = DIRECTIONS.filter((d) => d.axis === axis).map((d) => this.worst(d.key)).filter((v) => v !== null);
      return w.length ? Math.max(...w) : null;
    },
    clear() {
      for (const k of Object.keys(results)) results[k].length = 0;
      axes.x = { phase: 'idle' };
      axes.y = { phase: 'idle' };
      changed++;
    },
  };
}

export const PHOB_SNAPBACK = { min: -10, max: 10, standard: 4 };

export function phobAdvice(axis, worst, count, setting) {
  const hold = axis === 'x' ? 'A + X' : 'A + Y';
  const what = axis === 'x' ? 'Left and right' : 'Up and down';
  if (count < ENOUGH) return { kind: 'test', text: `${what}: flick and let go a few more times.` };
  const v = verdict(worst);
  if (setting === null || setting === undefined) {
    if (v === 'ok') return { kind: 'ok', text: `${what}: no swing gets near the deadzone. Leave it.` };
    return { kind: 'read', text: `${what}: swings ${v === 'crosses' ? 'past' : 'close to'} the deadzone. Read your settings (step 2) so the app can say which way to change it.` };
  }
  if (v === 'ok') {
    if (setting > PHOB_SNAPBACK.standard) return { kind: 'ok', text: `${what}: no swing gets near the deadzone. Leave it, or try one lower for a quicker stick: hold ${hold}, tap D-pad down.` };
    return { kind: 'ok', text: `${what}: no swing gets near the deadzone. Leave it at ${setting}.` };
  }
  if (setting === 0) {
    return { kind: 'change', text: `${what}: the filter is off (0). Hold ${hold} and tap D-pad up 4 times to get back to the standard 4.` };
  }
  if (setting < 0) {
    if (setting === PHOB_SNAPBACK.min) return { kind: 'stuck', text: `${what}: already at the strongest low-pass setting (-10). Try the standard filter instead: hold ${hold}, tap D-pad up until it reads 4.` };
    return { kind: 'change', text: `${what}: hold ${hold} and tap D-pad down once (in the minus range, lower numbers filter more). Then test again.` };
  }
  if (setting === PHOB_SNAPBACK.max) return { kind: 'stuck', text: `${what}: already at the most (10). The stick's spring or potentiometer may need a look.` };
  const tag = v === 'crosses' ? 'swings past the deadzone' : 'swings close to the deadzone';
  return { kind: 'change', text: `${what}: ${tag}. Hold ${hold} and tap D-pad up once. Then test again.` };
}

export const GCU_TYPES = { lowpass: 0, auto: 1, off: 2 };
export const GCU_CUTOFF = { min: 300, max: 1500, step: 150, standard: 600 };
export const gcuType = (n) => (n === 2 ? 'off' : n === 1 || n === 3 ? 'auto' : 'lowpass');
export const hz = (cutoff) => `${Math.round(cutoff / 10)} Hz`;

export function gcuAdvice(axis, worst, worstPre, count, tuning) {
  const what = axis === 'x' ? 'Left and right' : 'Up and down';
  if (count < ENOUGH) return { kind: 'test', text: `${what}: flick and let go a few more times.` };
  const v = verdict(worst);
  const caught = worstPre !== null && verdict(worstPre) !== 'ok' && v === 'ok';
  if (v === 'ok') return { kind: 'ok', text: `${what}: no swing gets near the deadzone${caught ? ' (the filter is catching it)' : ''}. Leave it.` };
  if (!tuning) return { kind: 'read', text: `${what}: swings ${v === 'crosses' ? 'past' : 'close to'} the deadzone.` };
  const type = gcuType(tuning.snapbackType);
  if (type === 'off') return { kind: 'change', text: `${what}: the filter is off. Turn on Auto.`, fix: { snapbackType: GCU_TYPES.auto } };
  if (type === 'auto') return { kind: 'change', text: `${what}: Auto isn't catching it. Try low-pass at ${hz(GCU_CUTOFF.standard)}.`, fix: { snapbackType: GCU_TYPES.lowpass, snapbackIntensity: GCU_CUTOFF.standard } };
  const c = Math.max(GCU_CUTOFF.min, Math.min(GCU_CUTOFF.max, tuning.snapbackIntensity));
  if (c <= GCU_CUTOFF.min) return { kind: 'stuck', text: `${what}: already at the strongest low-pass (${hz(GCU_CUTOFF.min)}).` };
  const next = Math.max(GCU_CUTOFF.min, c - GCU_CUTOFF.step);
  return { kind: 'change', text: `${what}: lower the low-pass to ${hz(next)} (lower filters more).`, fix: { snapbackType: GCU_TYPES.lowpass, snapbackIntensity: next } };
}

const ARM_MS = 150;
const ADJUST_MS = [550, 1100];
const SHOW_MS = [1600, 2500];
const TRIGGER_DOWN = 100;
const near = (v, lo, hi) => v >= lo && v <= hi;
const decode = (v) => v - 127;
const same = (a, b) => a.main.x === b.main.x && a.main.y === b.main.y && a.c.x === b.c.x && a.c.y === b.c.y
  && Math.abs(a.l - b.l) <= 1 && Math.abs(a.r - b.r) <= 1;

export function createPhobSettingsReader() {
  let armed = null;
  let win = null;
  let found = null;
  let prev = null;

  function close(t) {
    const w = win;
    win = null;
    if (!w) return;
    const d = t - w.start;
    const { main, c, l, r } = w.v;
    if (w.kind === 'adjust' && d >= ADJUST_MS[0] && d <= ADJUST_MS[1] && near(c.x, 117, 137) && near(c.y, 117, 137)) {
      found = { kind: 'snapback', t, snapback: { x: decode(c.x), y: decode(c.y) } };
    } else if (w.kind === 'show' && d >= SHOW_MS[0] && d <= SHOW_MS[1] && near(main.x, 117, 137) && near(main.y, 117, 137)
      && near(c.x, 127, 136) && near(c.y, 127, 136) && l <= 15 && r <= 15) {
      found = {
        kind: 'settings', t,
        snapback: { x: decode(main.x), y: decode(main.y) },
        smoothing: { x: decode(c.x), y: decode(c.y) },
        waveshaping: { x: l, y: r },
      };
    }
  }

  return {
    feed({ t, buttons, main, c, l, r }) {
      const b = buttons;
      const v = { main: { ...main }, c: { ...c }, l, r };
      const before = prev;
      prev = v;
      if (b.size) {
        if (win) close(t);
        if (b.has('A') && (b.has('X') !== b.has('Y')) && !b.has('Z') && !b.has('L') && !b.has('R')) armed = { kind: 'adjust', t };
        else if (!b.has('A') && !b.has('X') && !b.has('Y') && (b.has('START') || b.has('L') || l >= TRIGGER_DOWN)) armed = { kind: 'show', t };
        else armed = null;
        return;
      }
      if (win) {
        if (same(v, win.v)) return;
        if (t - win.start <= 20) { win.v = v; return; }
        close(t);
        return;
      }
      if (armed && t - armed.t <= ARM_MS && before && !same(v, before)) win = { kind: armed.kind, start: t, v };
      armed = null;
    },
    take() { const f = found; found = null; return f; },
  };
}
