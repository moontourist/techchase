import {
  CLOSE, DEADZONE, createPhobSettingsReader, createSnapbackMeter, gcuAdvice, melee, phobAdvice, verdict,
} from '../../tools/app/snapback.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

function flick(m, t0, { axis = 'x', sign = 1, bounce = 10, pre = null, fallMs = 8 } = {}) {
  let t = t0;
  const put = (v, p = null) => {
    const s = axis === 'x' ? { t, x: v, y: 0, preX: p, preY: 0 } : { t, x: 0, y: v, preX: 0, preY: p };
    if (p === null) { delete s.preX; delete s.preY; }
    m.feed(s);
    t += 1;
  };
  for (let i = 0; i < 50; i++) put(sign * 100, pre === null ? null : sign * 100);
  for (let i = 1; i <= fallMs; i++) put(sign * Math.round(100 * (1 - i / fallMs)), pre === null ? null : sign * Math.round(100 * (1 - i / fallMs)));
  for (let i = 1; i <= 10; i++) put(-sign * Math.round((bounce * i) / 10), pre === null ? null : -sign * Math.round((pre * i) / 10));
  for (let i = 1; i <= 10; i++) put(-sign * Math.round(bounce * (1 - i / 10)), pre === null ? null : -sign * Math.round(pre * (1 - i / 10)));
  for (let i = 0; i < 100; i++) put(0, pre === null ? null : 0);
  return t;
}

check(melee(DEADZONE) === '0.2875', 'Melee\'s deadzone is 23 units, 0.2875');
check(verdict(5) === 'ok' && verdict(CLOSE) === 'close' && verdict(DEADZONE) === 'crosses' && verdict(null) === 'none', 'bounces are graded ok, close, crosses');

const m = createSnapbackMeter();
let t = 0;
t = flick(m, t, { sign: 1, bounce: 12 });
t = flick(m, t, { sign: 1, bounce: 30 });
t = flick(m, t, { sign: -1, bounce: 8 });
t = flick(m, t, { axis: 'y', sign: 1, bounce: 18 });
check(m.results('right').length === 2 && m.worst('right') === 30, `two releases from the right, worst bounce 30 (got ${m.worst('right')})`);
check(m.worst('left') === 8, 'a release from the left is measured on its own');
check(m.worst('up') === 18 && m.worst('down') === null, 'up is measured, down is not yet');
check(m.count('x') === 3 && m.worstAxis('x') === 30, 'the x axis has three releases with a worst of 30');

const slow = createSnapbackMeter();
flick(slow, 0, { sign: 1, bounce: 40, fallMs: 200 });
check(slow.results('right').length === 0, 'easing the stick back to center by hand is not a release');

const dash = createSnapbackMeter();
let td = 0;
for (let i = 0; i < 30; i++) dash.feed({ t: td++, x: 100, y: 0 });
for (let i = 1; i <= 8; i++) dash.feed({ t: td++, x: Math.round(100 - i * 25), y: 0 });
for (let i = 0; i < 80; i++) dash.feed({ t: td++, x: -100, y: 0 });
check(dash.results('right').length === 0 && dash.results('left').length === 0, 'a dash to the other side is not a release (it reaches the rim)');

const pre = createSnapbackMeter();
let tp = 0;
for (let i = 0; i < 3; i++) tp = flick(pre, tp, { sign: 1, bounce: 6, pre: 34 });
check(pre.worst('right') === 6 && pre.worstPre('right') === 34, 'the GC Ultimate\'s value before the filter is measured too');
check(gcuAdvice('x', 6, 34, 3, { snapbackType: 1, snapbackIntensity: 600 }).text.includes('catching it'), 'a bounce the filter catches is called out');

check(phobAdvice('x', 30, 1, 4).kind === 'test', 'one release is not enough to judge');
check(phobAdvice('x', 8, 4, 4).kind === 'ok', 'a small bounce at the standard 4 is left alone');
check(phobAdvice('x', 8, 4, 7).text.includes('D-pad down'), 'a small bounce at a high setting may come down one');
const up = phobAdvice('x', 30, 4, 4);
check(up.kind === 'change' && up.text.includes('A + X') && up.text.includes('D-pad up'), 'a bounce past the deadzone on x says hold A + X, tap D-pad up');
check(phobAdvice('y', 30, 4, 4).text.includes('A + Y'), 'the y axis uses A + Y');
check(phobAdvice('x', 30, 4, -3).text.includes('D-pad down'), 'in the low-pass (minus) range, stronger is D-pad down');
check(phobAdvice('x', 30, 4, 0).text.includes('4 times'), 'with the filter off, it says how to get back to 4');
check(phobAdvice('x', 30, 4, 10).kind === 'stuck', 'at 10 there is nothing left to raise');
check(phobAdvice('x', 30, 4, null).kind === 'read', 'without the setting, it asks to read it first');

check(gcuAdvice('x', 30, 30, 4, { snapbackType: 2, snapbackIntensity: 600 }).fix.snapbackType === 1, 'GC Ultimate with the filter off: turn on Auto');
check(gcuAdvice('x', 30, 30, 4, { snapbackType: 1, snapbackIntensity: 600 }).fix.snapbackType === 0, 'GC Ultimate on Auto: try low-pass');
const lp = gcuAdvice('x', 30, 30, 4, { snapbackType: 0, snapbackIntensity: 600 });
check(lp.fix.snapbackIntensity === 450 && lp.text.includes('45 Hz'), 'GC Ultimate on low-pass 60 Hz: lower it to 45 Hz');
check(gcuAdvice('x', 30, 30, 4, { snapbackType: 0, snapbackIntensity: 300 }).kind === 'stuck', 'GC Ultimate at 30 Hz has nothing left');

function phobFeed(r, t0, steps) {
  let tt = t0;
  for (const s of steps) {
    for (let i = 0; i < s.ms; i++) {
      r.feed({ t: tt++, buttons: new Set(s.b ?? []), main: s.main ?? { x: 128, y: 128 }, c: s.c ?? { x: 128, y: 128 }, l: s.l ?? 0, r: s.r ?? 0 });
    }
  }
  return tt;
}

const reader = createPhobSettingsReader();
phobFeed(reader, 0, [
  { ms: 100 },
  { b: ['L'], l: 220, ms: 200 },
  { main: { x: 133, y: 131 }, c: { x: 129, y: 127 }, l: 3, r: 0, ms: 2000 },
  { b: ['L'], l: 220, ms: 100 },
]);
const got = reader.take();
check(got?.kind === 'settings' && got.snapback.x === 6 && got.snapback.y === 4, `L + Start's display reads snapback x 6, y 4 (got ${JSON.stringify(got?.snapback)})`);
check(got?.smoothing.x === 2 && got.smoothing.y === 0 && got.waveshaping.x === 3, 'it also reads smoothing and waveshaping');

const adj = createPhobSettingsReader();
phobFeed(adj, 0, [
  { ms: 100 },
  { b: ['A', 'X'], ms: 300 },
  { c: { x: 132, y: 131 }, ms: 750 },
  { b: ['A', 'X'], ms: 100 },
]);
const a = adj.take();
check(a?.kind === 'snapback' && a.snapback.x === 5 && a.snapback.y === 4, `A + X + D-pad up's display reads the new snapback (got ${JSON.stringify(a?.snapback)})`);

const neg = createPhobSettingsReader();
phobFeed(neg, 0, [{ b: ['A', 'Y'], ms: 200 }, { c: { x: 124, y: 117 }, ms: 750 }, { b: ['A', 'Y'], ms: 50 }]);
const n = neg.take();
check(n?.snapback.x === -3 && n.snapback.y === -10, 'negative settings decode too (-3, -10)');

const pause = createPhobSettingsReader();
phobFeed(pause, 0, [{ b: ['START'], ms: 120 }, { ms: 2000 }, { main: { x: 180, y: 128 }, ms: 50 }]);
check(pause.take() === null, 'pressing Start, letting go and resting is not read as a settings display');

const smooth = createPhobSettingsReader();
phobFeed(smooth, 0, [{ b: ['R', 'X'], ms: 200 }, { c: { x: 130, y: 127 }, ms: 750 }, { b: ['R', 'X'], ms: 50 }]);
check(smooth.take() === null, 'the smoothing display (R + X) is not mistaken for snapback');

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
