export const GC_PER_FW = 110 / 2048;
export function gcAxis(fw) {
  const v = Math.floor(fw * GC_PER_FW);
  return Math.max(-128, Math.min(127, v));
}

export const MELEE_RADIUS = 80;
export const MELEE_DEADZONE = 23;
export function meleeUnits(x, y) {
  let mx = x;
  let my = y;
  const r2 = x * x + y * y;
  if (r2 > MELEE_RADIUS * MELEE_RADIUS) {
    const r = Math.sqrt(r2);
    mx = Math.trunc((x * MELEE_RADIUS) / r);
    my = Math.trunc((y * MELEE_RADIUS) / r);
  }
  if (Math.abs(mx) < MELEE_DEADZONE) mx = 0;
  if (Math.abs(my) < MELEE_DEADZONE) my = 0;
  return [mx, my];
}
export const meleeValue = (units) => units / MELEE_RADIUS;
export const fmtMelee = (units) => {
  const v = meleeValue(units);
  return `${v < 0 ? '-' : ' '}${Math.abs(v).toFixed(4)}`;
};

export const gcTrigger = (fw12, digital) => (digital ? 255 : Math.max(0, Math.min(255, fw12 >> 4)));

export const NOTCHES = [
  { name: 'Right', deg: 0, ideal: [80, 0] },
  { name: 'Up-right', deg: 45, ideal: [56, 56] },
  { name: 'Up', deg: 90, ideal: [0, 80] },
  { name: 'Up-left', deg: 135, ideal: [-56, 56] },
  { name: 'Left', deg: 180, ideal: [-80, 0] },
  { name: 'Down-left', deg: 225, ideal: [-56, -56] },
  { name: 'Down', deg: 270, ideal: [0, -80] },
  { name: 'Down-right', deg: 315, ideal: [56, -56] },
];

export function nearestNotch(x, y, { minRadius = 70, maxDegrees = 12 } = {}) {
  if (Math.hypot(x, y) < minRadius) return null;
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  let best = null;
  for (const [i, n] of NOTCHES.entries()) {
    const d = Math.abs(((deg - n.deg + 540) % 360) - 180);
    if (d <= maxDegrees && (!best || d < best.d)) best = { i, d };
  }
  return best ? best.i : null;
}

export function notchError(i, [mx, my]) {
  const [ix, iy] = NOTCHES[i].ideal;
  return Math.max(Math.abs(mx - ix), Math.abs(my - iy));
}
