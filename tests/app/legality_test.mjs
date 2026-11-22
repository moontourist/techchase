import {
  NOTCH_LIMITS, RESCUE_ANGLE, buildReport, createReachMeter, createRestMeter, createTriggerMeter, notchAngleCheck, reachResult,
  reportText, summary,
} from '../../tools/app/legality.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };
const rad = (d) => (d * Math.PI) / 180;

function circle(meter, radiusAt) {
  for (let d = 0; d < 720; d += 0.5) {
    const r = radiusAt(d % 360);
    meter.feed(Math.round(r * Math.cos(rad(d))), Math.round(r * Math.sin(rad(d))));
  }
  meter.feed(0, 0);
}
const phobGate = (d) => {
  const a = rad(d);
  const k = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a)) ? Math.abs(Math.cos(a)) : Math.abs(Math.sin(a));
  return Math.min(100 / k, 104);
};

{
  const m = createReachMeter();
  circle(m, phobGate);
  const res = reachResult(m);
  check(m.done, 'a full circle and a release finish the reach step');
  check(res.far.r > 100 && res.far.r <= 110 && res.low.r >= 99, `a Phob gate reaches 100 to 104 (got ${res.low.r.toFixed(1)} to ${res.far.r.toFixed(1)})`);
  check(buildReport({ reach: { main: res } })[0].status === 'pass', 'a Phob gate passes the reach rule');
}
{
  const m = createReachMeter();
  circle(m, (d) => phobGate(d) * 1.07);
  const res = reachResult(m);
  const row = buildReport({ reach: { main: res } })[0];
  check(row.status === 'fail' && row.text.includes('past 110') && row.text.includes('up-right'), `a scaler of 107 still passes the cardinals but fails at the diagonals (${row.text})`);
}
{
  const m = createReachMeter();
  circle(m, (d) => (Math.abs(d - 180) < 20 ? 85 : 100));
  const row = buildReport({ reach: { main: reachResult(m) } })[0];
  check(row.status === 'fail' && row.text.includes('left') && row.text.includes('needs 90'), `a stick that reaches only 85 at left fails (${row.text})`);
}
{
  const m = createReachMeter();
  for (let d = 0; d < 300; d++) m.feed(Math.round(100 * Math.cos(rad(d))), Math.round(100 * Math.sin(rad(d))));
  m.feed(0, 0);
  check(!m.done && reachResult(m) === null, 'a partial circle does not finish, and reads as not measured');
}

{
  const r = createRestMeter();
  let t = 0;
  for (; t < 300; t++) r.feed({ t, buttons: 0, mx: 128 + (t % 2), my: 128, cx: 127, cy: 129, l: 0, r: 0 });
  check(r.rest === null, 'the rest step waits for half a second of stillness');
  for (; t < 600; t++) r.feed({ t, buttons: 0, mx: 128 + (t % 2), my: 128, cx: 127, cy: 129, l: 0, r: 0 });
  check(r.rest && r.rest.cx === 127 && r.rest.cy === 129, 'still sticks give the rest point');
  const moving = createRestMeter();
  for (let s = 0; s < 1000; s++) moving.feed({ t: s, buttons: 0, mx: 128 + (s % 20), my: 128, cx: 128, cy: 128, l: 0, r: 0 });
  check(moving.rest === null, 'a moving stick never settles');
}

function press(m, values, { dig = () => false, t0 = 0 } = {}) {
  let t = t0;
  for (const v of values) m.feed({ t: t++, analog: v, digital: dig(v) });
  for (let i = 0; i < 400; i++) m.feed({ t: t++, analog: 0, digital: false });
}
const ramp = (to) => [...Array(200).keys()].map((i) => Math.round((to * i) / 199));
{
  const m = createTriggerMeter();
  press(m, [...ramp(200), ...Array(100).fill(200), ...ramp(200).reverse()], { dig: (v) => v >= 200 });
  const res = m.result();
  check(m.done && res.kind === 'analog' && res.max === 200 && res.digital, 'a slow press reads as analog, up to 200, with the click');
  const row = buildReport({ triggers: { l: res } }).find((r) => r.rule === 'L trigger press');
  check(row.status === 'pass' && row.text.includes('Melee stops at 140'), 'an analog press passes and notes Melee\'s cap');
}
for (const [v, want] of [[42, 'pass'], [43, 'fail'], [48, 'fail'], [49, 'pass']]) {
  const m = createTriggerMeter();
  press(m, [...Array(50).fill(0), ...Array(300).fill(v)]);
  const res = m.result();
  const row = buildReport({ triggers: { r: res } }).find((r) => r.rule === 'R trigger press');
  check(res.kind === 'fixed' && res.value === v && row.status === want, `a press that jumps to exactly ${v} is a ${want}`);
}
{
  const m = createTriggerMeter();
  press(m, Array(300).fill(0), { dig: () => true });
  check(m.result().kind === 'digital', 'a press with no analog value reads as digital only');
}
for (const [v, want] of [[0, 'pass'], [12, 'warn'], [50, 'fail']]) {
  const row = buildReport({ rest: { l: v, r: 0 } }).find((r) => r.rule === 'L trigger at rest');
  check(row.status === want, `a trigger resting at ${v} is a ${want}`);
}

const std = [...Array(16).keys()].map((i) => (i % 2 ? null : rad(i * 22.5)));
const withDiag = (deg) => std.map((a, i) => (i === 2 ? rad(deg) : a));
check(notchAngleCheck(std, std).ok, 'unchanged notches pass');
{
  const measured = withDiag(40);
  check(notchAngleCheck(measured, std).ok, 'a worn diagonal at 40 degrees remapped to 45 passes (45/40 is 12.5% stretch)');
  check(!notchAngleCheck(withDiag(34), std).ok, 'a diagonal at 34 degrees remapped to 45 fails (32% stretch)');
  check(notchAngleCheck(withDiag(34.7), std).ok, 'a diagonal at 34.7 degrees remapped to 45 passes (29.7% stretch)');
  const compress = 45 * NOTCH_LIMITS.diagonal.compress;
  check(notchAngleCheck(withDiag(45), withDiag(compress + 0.1)).ok && !notchAngleCheck(withDiag(45), withDiag(compress - 0.1)).ok,
    'a diagonal compressed toward a cardinal passes just inside 23.1% and fails just outside');
}
{
  const m = std.map((a, i) => (i === 1 ? rad(22.5) : a));
  check(notchAngleCheck(m, m.map((a, i) => (i === 1 ? rad(33.7) : a))).ok, 'a modder notch moved from 22.5 to 33.7 degrees passes (49.8% stretch on one side, 49.8% compression on the other)');
  check(!notchAngleCheck(m, m.map((a, i) => (i === 1 ? rad(34) : a))).ok, 'moved to 34 degrees it fails: the far side is compressed past 50%');
  check(!notchAngleCheck(m, m.map((a, i) => (i === 1 ? rad(10) : a))).ok, 'a modder notch compressed past 50% (22.5 to 10 degrees) fails');
}
{
  const m = std.map((a, i) => (i === 3 ? rad(90 - 8) : a));
  const out = (deg) => m.map((a, i) => (i === 3 ? rad(90 - deg) : a));
  const rescue = (RESCUE_ANGLE * 180) / Math.PI;
  check(notchAngleCheck(m, out(rescue - 0.1)).ok, `a worn notch 8 degrees from up, inside the deadzone, may stretch to ${rescue.toFixed(2)} degrees (0.3250, 0.9375)`);
  check(!notchAngleCheck(m, out(rescue + 0.5)).ok, 'but not past it');
  check(notchAngleCheck(m.map((a, i) => (i === 3 ? rad(90 - 4) : a)), m.map((a, i) => (i === 3 ? rad(90 - 12) : a))).ok,
    'a notch at 4 degrees stretched to 12 is within the rescue angle');
}
{
  const wrap = std.map((a, i) => (i === 14 ? rad(315) : a));
  check(notchAngleCheck(wrap, wrap.map((a, i) => (i === 14 ? rad(320) : a))).ok, 'angles wrap through 360 degrees (down-right to right)');
}

{
  const rows = buildReport({});
  check(summary(rows).status === 'skip', 'with nothing measured, the summary says steps were skipped');
  check(rows.some((r) => r.rule === 'Digital controller rules' && r.status === 'note'), 'the box-controller rules are one line, marked as not applying');
  const text = reportText(rows, { date: new Date('2026-11-21T12:00:00Z') });
  check(text.includes('0ffc24d') && text.includes('2026-11-21') && text.includes('not a ruling'), 'the copied report names the ruleset version, the date, and that it is a self-check');
  const other = buildReport({ phob: false });
  check(other.find((r) => r.rule === 'Stick filters').status === 'note', 'for another controller, firmware rules are notes, not passes');
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
