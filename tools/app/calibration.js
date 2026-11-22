export const CFG_BLOCK_ANALOG = 2;
export const ANALOG_BLOCK_SIZE = 1024;
export const ANALOG_CMD = { REFRESH: 0, CALIBRATE_START: 1, CALIBRATE_STOP: 2, CAPTURE_LEFT: 3, CAPTURE_RIGHT: 4 };

const SLOT_SIZE = 21;
const SLOT_COUNT = 16;
const SLOTS_AT = { l: 10, r: 10 + SLOT_SIZE * SLOT_COUNT };
const CENTERS_AT = 2;
const CENTERS_END = 10;
const NOTCH_COUNT = 8;
const DEFAULT_DEADZONE = 2;
const DEFAULT_OUT_DISTANCE = 2048;
const TUNING_AT = SLOTS_AT.r + SLOT_SIZE * SLOT_COUNT;
const SPRING_SIZE = 74;
const SPRINGS_AT = TUNING_AT + 16;
export const FACTORY = { inDistance: 1400, deadzone: 144, deadzoneOuter: 72, snapbackType: 1, snapbackIntensity: 600, exp: 51 };

export const MIN_NOTCH_DISTANCE = 1000;
export const MAX_NOTCH_ANGLE_OFF = 20;
export const STILL_MS = 250;
export const STILL_DEGREES = 1;
export const STILL_COUNTS = 20;
export const CENTER_STILL_COUNTS = 12;

function view(bytes) {
  if (bytes.length !== ANALOG_BLOCK_SIZE) throw new Error(`the analog settings are ${bytes.length} bytes, expected ${ANALOG_BLOCK_SIZE}`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function readSlots(bytes, side) {
  const v = view(bytes);
  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const at = SLOTS_AT[side] + i * SLOT_SIZE;
    slots.push({
      inAngle: v.getFloat32(at, true),
      outAngle: v.getFloat32(at + 4, true),
      deadzone: v.getFloat32(at + 8, true),
      inDistance: v.getFloat32(at + 12, true),
      outDistance: v.getFloat32(at + 16, true),
      enabled: v.getUint8(at + 20) !== 0,
    });
  }
  return slots;
}

export function parseAnalog(bytes) {
  const v = view(bytes);
  const center = (at) => v.getUint16(at, true) >> 1;
  return {
    version: v.getUint8(0),
    calibrationSet: v.getUint8(1),
    centers: { lx: center(2), ly: center(4), rx: center(6), ry: center(8) },
    l: readSlots(bytes, 'l'),
    r: readSlots(bytes, 'r'),
  };
}

export function writeSlots(bytes, side, slots) {
  if (slots.length !== SLOT_COUNT) throw new Error(`expected ${SLOT_COUNT} slots, got ${slots.length}`);
  const out = new Uint8Array(bytes);
  const v = view(out);
  slots.forEach((s, i) => {
    const at = SLOTS_AT[side] + i * SLOT_SIZE;
    v.setFloat32(at, s.inAngle, true);
    v.setFloat32(at + 4, s.outAngle, true);
    v.setFloat32(at + 8, s.deadzone, true);
    v.setFloat32(at + 12, s.inDistance, true);
    v.setFloat32(at + 16, s.outDistance, true);
    v.setUint8(at + 20, s.enabled ? 1 : 0);
  });
  return out;
}

export function withNewCenters(backup, fresh) {
  view(backup);
  view(fresh);
  const out = new Uint8Array(backup);
  out.set(fresh.subarray(CENTERS_AT, CENTERS_END), CENTERS_AT);
  out[1] = fresh[1];
  return out;
}

export const angleOff = (a, b) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};

export function notchSlots(oldSlots, captures) {
  if (captures.length !== NOTCH_COUNT || captures.some((c) => !c)) throw new Error('all eight notches are needed');
  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (i >= NOTCH_COUNT) {
      slots.push({ ...oldSlots[i], enabled: false });
      continue;
    }
    const out = i * 45;
    const old = oldSlots.find((s) => s.enabled && angleOff(s.outAngle, out) < 0.01);
    slots.push({
      inAngle: captures[i].angle,
      outAngle: out,
      deadzone: old ? old.deadzone : DEFAULT_DEADZONE,
      inDistance: captures[i].distance,
      outDistance: old ? old.outDistance : DEFAULT_OUT_DISTANCE,
      enabled: true,
    });
  }
  return slots;
}

export function checkCapture(i, cap) {
  if (!cap || !Number.isFinite(cap.angle) || !Number.isFinite(cap.distance)) return 'no reading';
  if (cap.distance < MIN_NOTCH_DISTANCE) return 'push the stick all the way into the notch';
  if (angleOff(cap.angle, i * 45) > MAX_NOTCH_ANGLE_OFF) return 'that is a different notch';
  return null;
}

export function nudge(slots, i, degrees) {
  return slots.map((s, j) => (j === i ? { ...s, inAngle: (((s.inAngle + degrees) % 360) + 360) % 360 } : s));
}

export class StillDetector {
  constructor({ ms = STILL_MS, degrees = STILL_DEGREES, counts = STILL_COUNTS } = {}) {
    this.ms = ms;
    this.degrees = degrees;
    this.counts = counts;
    this.samples = [];
  }

  reset() { this.samples = []; }

  feed(sample, now) {
    this.samples.push({ ...sample, t: now });
    while (this.samples.length && now - this.samples[0].t > this.ms * 2) this.samples.shift();
    const span = this.samples.filter((s) => now - s.t <= this.ms);
    if (!span.length || now - this.samples[0].t < this.ms) return null;
    const ds = span.map((s) => s.distance);
    if (Math.max(...ds) - Math.min(...ds) > this.counts) return null;
    if (this.degrees !== null) {
      const ref = span[0].angle;
      if (span.some((s) => angleOff(s.angle, ref) > this.degrees)) return null;
    }
    let sx = 0;
    let sy = 0;
    for (const s of span) {
      sx += Math.cos((s.angle * Math.PI) / 180);
      sy += Math.sin((s.angle * Math.PI) / 180);
    }
    const angle = (((Math.atan2(sy, sx) * 180) / Math.PI) + 360) % 360;
    return { angle, distance: ds.reduce((a, b) => a + b, 0) / ds.length };
  }
}

export function readTuning(bytes, side) {
  const v = view(bytes);
  const [a, b] = side === 'l' ? [0, 0] : [1, 2];
  const spring = SPRINGS_AT + (side === 'l' ? 0 : SPRING_SIZE);
  return {
    deadzone: v.getUint16(TUNING_AT + b, true),
    snapbackType: v.getUint8(TUNING_AT + 4 + a),
    deadzoneOuter: v.getUint16(TUNING_AT + 6 + b, true),
    snapbackIntensity: v.getUint16(TUNING_AT + 10 + b, true),
    exp: v.getUint8(TUNING_AT + 14 + a),
    springTuned: (v.getUint8(spring + 1) & 1) === 1 && v.getUint8(spring) === 1,
  };
}

export function defaultSlots() {
  return Array.from({ length: SLOT_COUNT }, (_, i) => (i < NOTCH_COUNT
    ? { inAngle: i * 45, outAngle: i * 45, deadzone: DEFAULT_DEADZONE, inDistance: FACTORY.inDistance, outDistance: DEFAULT_OUT_DISTANCE, enabled: true }
    : { inAngle: 0, outAngle: 0, deadzone: 0, inDistance: 0, outDistance: 0, enabled: false }));
}

export function factoryDefaults(bytes, fresh) {
  let out = withNewCenters(bytes, fresh);
  const v = view(out);
  for (let at = CENTERS_AT; at < CENTERS_END; at += 2) v.setUint16(at, v.getUint16(at, true) & ~1, true);
  out = writeSlots(writeSlots(out, 'l', defaultSlots()), 'r', defaultSlots());
  const w = view(out);
  w.setUint8(1, 0);
  for (const b of [0, 2]) {
    w.setUint16(TUNING_AT + b, FACTORY.deadzone, true);
    w.setUint16(TUNING_AT + 6 + b, FACTORY.deadzoneOuter, true);
    w.setUint16(TUNING_AT + 10 + b, FACTORY.snapbackIntensity, true);
  }
  for (const a of [0, 1]) {
    w.setUint8(TUNING_AT + 4 + a, FACTORY.snapbackType);
    w.setUint8(TUNING_AT + 14 + a, FACTORY.exp);
  }
  out.fill(0, SPRINGS_AT, SPRINGS_AT + 2 * SPRING_SIZE);
  return out;
}

export function tuningLooksBroken(bytes) {
  return ['l', 'r'].some((side) => {
    const t = readTuning(bytes, side);
    return t.deadzone > 2048 || t.deadzoneOuter > 2048 || t.snapbackType > 8 || t.snapbackIntensity > 10000;
  });
}
