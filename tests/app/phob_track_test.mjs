import {
  ADJUST_ORDER, MEASURE_ORDER, classify, createPhobTracker, notchHint, targetOf,
} from '../../tools/app/phob-track.js';
import { REPORT_LEN, parseAdapterReport, AdapterPad } from '../../tools/app/adapter-source.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const MAX_ANGLE = 0.4886921906;
function target(deg) {
  const a = (deg * Math.PI) / 180;
  const v = (c) => Math.trunc((100 * Math.atan2(Math.sin(MAX_ANGLE) * c, Math.cos(MAX_ANGLE))) / MAX_ANGLE + 127.5);
  return { x: v(Math.cos(a)), y: v(Math.sin(a)) };
}
const CENTER = { x: 127, y: 127 };
const FROZEN = { x: 255, y: 255 };

function run(steps, opts = {}) {
  const t = createPhobTracker(opts);
  let now = 0;
  const events = [];
  for (const s of steps) {
    for (let i = 0; i < (s.ms ?? 40); i++) {
      now += 1;
      t.feed({
        t: now,
        buttons: new Set(s.buttons ?? []),
        raw: { main: s.main ?? CENTER, c: s.c ?? CENTER },
        trig: { l: s.l ?? 0, r: s.r ?? 0 },
        self: { main: s.self ?? { x: 0, y: 0 }, c: { x: 0, y: 0 } },
      });
    }
    events.push(...t.nextEvents());
  }
  return { t, events };
}

check(classify(127, 127).kind === 'center' && classify(128, 128).kind === 'center', 'the Phob centre (127 or 128) reads as centre');
check(classify(255, 255).kind === 'freeze', 'sticks pinned at 255 read as a command freeze');
for (const n of MEASURE_ORDER) {
  const p = target(n * 22.5);
  const c = classify(p.x, p.y);
  const off = Math.abs(((c.deg - n * 22.5 + 540) % 360) - 180);
  if (c.kind !== 'rim' || off > 2) check(false, `notch ${n} target (${p.x}, ${p.y}) reads as rim within 2 degrees (got ${c.kind}, ${off.toFixed(2)})`);
}
check(true, 'all 16 rim targets read as rim within 2 degrees');
check(classify(177, 177).kind === 'other', 'the toggle indicator (centre + 50) is not mistaken for a rim target');

const safe = run([
  { buttons: ['A', 'X', 'Y', 'START'], ms: 100 },
  { main: FROZEN, c: FROZEN, ms: 2000 },
  { ms: 50 },
]);
check(safe.t.safe === 'off' && safe.events.some((e) => e.text === 'Safe mode is off.'), 'a 2 s freeze after A+X+Y+Start means safe mode went off');
const safeOn = run([
  { buttons: ['A', 'X', 'Y', 'START'], ms: 100 },
  { main: FROZEN, c: FROZEN, ms: 4000 },
  { ms: 50 },
]);
check(safeOn.t.safe === 'on', 'a 4 s freeze means safe mode went back on');
const locked = run([{ buttons: ['A', 'X', 'Y', 'L'], ms: 100 }, { ms: 1600 }]);
check(locked.t.safe === 'on' && locked.t.phase === 'ready', 'A+X+Y+L with no freeze means safe mode is still on');

function fullCalibration({ eightOnly = true, badPress = null } = {}) {
  const steps = [{ buttons: ['A', 'X', 'Y', 'L'], ms: 100 }, { main: FROZEN, c: FROZEN, ms: 2000 }];
  MEASURE_ORDER.forEach((n, k) => {
    const centerSelf = badPress === 2 * k ? { x: 60, y: 0 } : { x: 0, y: 0 };
    steps.push({ c: CENTER, self: centerSelf, ms: 300 });
    const rimHeld = !(n % 2 && eightOnly) && badPress !== 2 * k + 1;
    const a = (n * 22.5 * Math.PI) / 180;
    steps.push({ c: target(n * 22.5), self: rimHeld ? { x: Math.round(100 * Math.cos(a)), y: Math.round(100 * Math.sin(a)) } : { x: 0, y: 0 }, ms: 300 });
  });
  const measured = { 2: 43, 6: 137, 10: 226, 14: 311 };
  for (const n of ADJUST_ORDER.slice(0, eightOnly ? 4 : 12)) steps.push({ c: target(measured[n] ?? n * 22.5), ms: 300 });
  steps.push({ c: { x: 128, y: 127 }, ms: 300 });
  return steps;
}

const good = run(fullCalibration());
check(good.t.stick === 'main', 'A+X+Y+L and its freeze start a main stick calibration');
check(good.t.phase === 'done', 'the tracker follows 32 points and 4 notches to the end');
check(JSON.stringify(good.t.adjusted) === JSON.stringify([2, 6, 10, 14]), 'the notch step visits up-right, up-left, down-left, down-right in order');
check(!good.events.some((e) => e.kind === 'warn'), 'a clean run raises no warnings');

const mid = run(fullCalibration().slice(0, 2 + 9));
check(mid.t.phase === 'measure' && mid.t.point === 8, `after the 4 cardinals and the next centre the tracker is on point 9 (index ${mid.t.point})`);

const pushed = run(fullCalibration({ badPress: 4 }));
check(pushed.events.some((e) => e.kind === 'warn' && e.text.startsWith('Point 5')), 'a centre measured with the stick pushed is flagged');
const loose = run(fullCalibration({ badPress: 9 }));
check(loose.events.some((e) => e.kind === 'warn' && e.text.includes('up-right')), 'an up-right point measured with the stick centered is flagged');

const skipSteps = [{ buttons: ['A', 'X', 'Y', 'R'], ms: 100 }, { main: FROZEN, c: FROZEN, ms: 2000 },
  { main: CENTER, ms: 200 }, { main: CENTER, buttons: ['START'], ms: 50 }, { main: target(48), ms: 200 }, { main: target(133), ms: 200 }, { main: CENTER, ms: 200 }];
const skip = run(skipSteps);
check(skip.t.stick === 'c' && skip.t.phase === 'done' && skip.t.adjusted[0] === 2, 'Start skips the c-stick straight to its notches (shown on the main stick)');

check(notchHint(2, [57, 55], true).kind === 'ccw', 'up-right landing at (0.7125, 0.6875), below 45 degrees, wants Y (counterclockwise)');
check(notchHint(2, [55, 57], true).kind === 'cw', 'up-right landing at (0.6875, 0.7125), above 45 degrees, wants X (clockwise)');
check(notchHint(2, [56, 56], true).kind === 'on', 'up-right at (0.7000, 0.7000) is on target');
check(notchHint(14, [57, -55], true).kind === 'cw', 'down-right landing at (0.7125, -0.6875) wants X');
check(notchHint(2, [57, 57], true).kind === 'distance', 'the right angle at the wrong distance says so');
check(notchHint(2, [57, 55], false).kind === 'hold', 'no hint until the stick is in the notch');

const report = new Uint8Array(REPORT_LEN);
report[0] = 0x21;
report.set([0x10, 0x01 | 0x08, 0x08, 130, 125, 128, 127, 40, 0], 1);
const ports = parseAdapterReport(report);
check(ports[0].connected && !ports[1].connected && ports[0].buttons.has('A') && ports[0].buttons.has('Y') && ports[0].buttons.has('L'), 'an adapter report gives port 1 connected with A, Y and L');
const pad = new AdapterPad();
let seen = null;
pad.onReading((_, rep) => { seen = rep; });
pad.usePort(0);
pad.feed(ports);
const moved = new Uint8Array(report);
moved[4] = 200;
pad.feed(parseAdapterReport(moved));
check(seen && seen.game.lx === 70 && seen.game.ly === 0, 'stick positions count from the first reading after connecting, as Dolphin does');

const unseen = run([{ buttons: ['A', 'X', 'Y'], ms: 100 }, { main: FROZEN, c: FROZEN, ms: 2000 }, { ms: 50 }]);
check(unseen.t.phase === 'measure' && unseen.t.stick === 'main', 'a 2 s freeze starts calibrating even when the adapter never shows all four buttons (the Phob blanks them as it acts)');
const byTrigger = run([{ buttons: ['A', 'X', 'Y'], r: 180, ms: 100 }, { main: FROZEN, c: FROZEN, ms: 2000 }, { ms: 50 }]);
check(byTrigger.t.stick === 'c', 'R held just before the freeze means the c-stick');
const preferred = run([{ main: FROZEN, c: FROZEN, ms: 2000 }, { ms: 50 }], { stick: 'c' });
check(preferred.t.stick === 'c', 'with no sign of L or R, the stick the player picked is used');
const right = targetOf(0);
check(right.x === 227 && right.y === 127, `the right target is (227, 127), as the Phob draws it (got ${right.x}, ${right.y})`);
const midway = run([{ c: targetOf(4), ms: 500 }, { c: CENTER, ms: 100 }, { c: targetOf(8), ms: 100 }]);
check(midway.t.phase === 'measure' && midway.t.stick === 'main' && midway.t.point === 5, `a calibration already under way is picked up from the target on the c-stick (point ${midway.t.point + 1})`);

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
