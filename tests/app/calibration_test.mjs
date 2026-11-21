import {
  ANALOG_BLOCK_SIZE, StillDetector, angleOff, checkCapture, notchSlots, nudge, parseAnalog, readSlots, withNewCenters,
  writeSlots,
} from '../../tools/app/calibration.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

function block() {
  let b = new Uint8Array(ANALOG_BLOCK_SIZE);
  b[0] = 0x13;
  b[1] = 1;
  const v = new DataView(b.buffer);
  v.setUint16(2, (2001 << 1) | 1, true);
  v.setUint16(4, 2002 << 1, true);
  v.setUint16(6, 2003 << 1, true);
  v.setUint16(8, 2004 << 1, true);
  const slots = Array.from({ length: 16 }, (_, i) => ({
    inAngle: i * 22.5, outAngle: i < 8 ? i * 45 : 0, deadzone: i === 2 ? 3 : 2, inDistance: 1400 + i, outDistance: i === 1 ? 2000 : 2048, enabled: i < 10,
  }));
  b = writeSlots(b, 'l', slots);
  b = writeSlots(b, 'r', slots.map((s) => ({ ...s, inDistance: 900 })));
  b[1000] = 0xAB;
  return b;
}

const b = block();
const a = parseAnalog(b);
check(a.version === 0x13 && a.calibrationSet === 1, 'version and calibration flag');
check(a.centers.lx === 2001 && a.centers.ly === 2002 && a.centers.ry === 2004, 'centers skip the invert bit');
check(a.l.length === 16 && near(a.l[3].inAngle, 67.5) && a.l[9].enabled && !a.l[10].enabled, 'left slots read back');
check(near(a.r[0].inDistance, 900), 'right slots are their own');
check(writeSlots(b, 'l', a.l).every((x, i) => x === b[i]), 'writing the slots read is byte for byte the same');

let threw = false;
try { parseAnalog(new Uint8Array(1000)); } catch { threw = true; }
check(threw, 'a block of the wrong size is refused');

const fresh = new Uint8Array(b);
new DataView(fresh.buffer).setUint16(2, 2040 << 1, true);
fresh[1] = 1;
fresh[20] = 0x77;
const merged = withNewCenters(b, fresh);
check(parseAnalog(merged).centers.lx === 2040 && merged[20] === b[20] && merged[1000] === 0xAB, 'new centers come from the fresh block, all else from the old');

const caps = [0, 45, 90, 135, 180, 225, 270, 315].map((d, i) => ({ angle: (d + (i % 2 ? 1.7 : -0.8) + 360) % 360, distance: 1500 + i }));
const slots = notchSlots(a.l, caps);
check(slots.length === 16 && slots.slice(0, 8).every((s, i) => s.enabled && s.outAngle === i * 45), 'eight notches map to the eight directions');
check(near(slots[0].inAngle, 359.2) && near(slots[3].inDistance, 1503), 'a notch keeps its captured angle and distance');
check(slots[2].deadzone === 3 && slots[1].outDistance === 2000, 'deadzone and output distance carry over from the old direction');
check(slots.slice(8).every((s) => !s.enabled), 'extra slots are turned off');
threw = false;
try { notchSlots(a.l, caps.slice(0, 7)); } catch { threw = true; }
check(threw, 'seven notches are not enough');

check(checkCapture(1, { angle: 47, distance: 1500 }) === null, 'a good notch passes');
check(/all the way/.test(checkCapture(1, { angle: 47, distance: 600 })), 'a short push is caught');
check(/different notch/.test(checkCapture(1, { angle: 90, distance: 1500 })), 'the wrong notch is caught');
check(checkCapture(0, { angle: 355, distance: 1500 }) === null, 'right notch passes just below 360');
check(angleOff(359, 1) === 2 && angleOff(10, 350) === 20, 'angle differences wrap');

const turned = nudge(slots, 0, 1);
check(near(turned[0].inAngle, 0.2) && turned[1] === slots[1], 'a nudge wraps and touches one notch');

const d = new StillDetector();
check(d.feed({ angle: 45, distance: 1500 }, 0) === null, 'one sample is not a hold');
let held = null;
for (let t = 10; t <= 300 && !held; t += 10) held = d.feed({ angle: 45 + (t % 20 ? 0.2 : -0.2), distance: 1500 + (t % 30) / 10 }, t);
check(held && near(held.angle, 45, 0.25) && near(held.distance, 1501, 2), 'a quarter second held still is captured, averaged');
const m = new StillDetector();
let moving = null;
for (let t = 0; t <= 600; t += 10) moving = m.feed({ angle: t / 10, distance: 1500 }, t) || moving;
check(moving === null, 'a stick sweeping round is never captured');
const w = new StillDetector();
let wrap = null;
for (let t = 0; t <= 300 && !wrap; t += 10) wrap = w.feed({ angle: t % 20 ? 359.8 : 0.2, distance: 1500 }, t);
check(wrap && angleOff(wrap.angle, 0) < 0.3, 'a hold across 0 degrees averages to 0, not 180');

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
