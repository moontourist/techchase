import { meleeUnits, meleeValue, nearestNotch, notchError, gcAxis } from '../../tools/app/melee.js';

const gts = [
  [0, 102, 0, 1],
  [76, 73, 0.7125, 0.6875],
  [100, 0, 1, 0],
  [74, -75, 0.7, -0.7],
  [0, -101, 0, -1],
  [-73, -73, -0.7, -0.7],
  [-101, 0, -1, 0],
  [-74, 77, -0.6875, 0.7125],
  [0, 0, 0, 0],
];

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

for (const [x, y, ex, ey] of gts) {
  const [mx, my] = meleeUnits(x, y);
  check(meleeValue(mx) === ex && meleeValue(my) === ey, `raw (${x}, ${y}) -> Melee (${ex}, ${ey}), got (${meleeValue(mx)}, ${meleeValue(my)})`);
}
check(meleeUnits(22, 0)[0] === 0 && meleeUnits(23, 0)[0] === 23, 'deadzone: 22 reads 0, 23 reads 0.2875');
check(nearestNotch(76, 73) === 1 && nearestNotch(0, -101) === 6, 'nearest notch: up-right and down');
check(nearestNotch(20, 20) === null && nearestNotch(100, 50) === null, 'no notch near the center or between notches');
check(notchError(1, meleeUnits(76, 73)) === 1, 'up-right (57, 55) is 1 unit from (56, 56)');
check(gcAxis(2048) === 110 && gcAxis(-2048) === -110 && gcAxis(-1) === -1 && gcAxis(0) === 0, 'firmware to GameCube units');

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
