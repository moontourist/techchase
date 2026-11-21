// Drives the real controller with the app's own protocol module (tools/app/gcu-protocol.js) through
// Node's WebUSB. Restores whatever layout the controller had before it started.
//
//   cd tests/app && npm install && node protocol_test.mjs
import { WebUSB } from 'usb';
import {
  GcuDevice, GC_CODES, codeName, remappable, jobs, layoutOf, applyLayout, FORMATS, LATCH_MODES,
} from '../../tools/app/gcu-protocol.js';

const webusb = new WebUSB({ allowAllDevices: true });
const found = (await webusb.getDevices()).filter((d) => d.vendorId === 0x057E || d.vendorId === 0x2E8A);
let dev;
for (const d of found) {
  try {
    const g = new GcuDevice(d);
    await g.open();
    dev = g;
    break;
  } catch (e) {
    console.log(`skip ${d.vendorId.toString(16)}:${d.productId.toString(16)}: ${e.message}`);
  }
}
if (!dev) { console.error('no techchase controller with a config interface'); process.exit(1); }

let failures = 0;
let original = null;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

try {
  const di = await dev.deviceInfo();
  console.log(`device ${dev.productName} (${dev.vendorId.toString(16)}:${dev.productId.toString(16)}) board ${di.name} fw ${di.fwVersion}`);
  check(di.name.length > 0 && di.fwVersion > 1700000000, 'static device block read (name, firmware version)');

  const info = await dev.info();
  console.log('info', info, FORMATS[info.reportFormat], LATCH_MODES[info.latchMode]);
  check(info.techchase && info.proto === 1, 'techchase INFO reply');

  await dev.resetStats();
  await new Promise((r) => setTimeout(r, 300));
  const st = await dev.stats();
  console.log('stats', st);
  check(st.version >= 1, 'STATS reply parses');

  const before = await dev.map();
  original = layoutOf(before);
  console.log(`map: ${before.length} inputs, ${remappable(before).length} remappable, ${jobs(before).length} jobs, ` +
    `layout now ${JSON.stringify(original)}`);
  check(before.length >= 20 && remappable(before).length >= 12, 'MAP pages read');
  check(!remappable(before).some((e) => e.name === 'Power'), 'Power (the modifier) not offered');

  const byName = Object.fromEntries(before.map((e) => [e.name, e]));
  const zr = byName.ZR, x = byName.X;
  check(zr && x, 'ZR and X present');

  // One remap, as the Controls screen does it
  check(await dev.assign(zr.code, x.code), 'ASSIGN ZR -> X accepted');
  let m = Object.fromEntries((await dev.map()).map((e) => [e.name, e]));
  check(codeName(GC_CODES, m.ZR.gcCur) === 'X' && m.ZR.swCur === x.swDef, 'ZR now jumps in GameCube and Switch profiles');
  check(JSON.stringify(layoutOf(Object.values(m))).includes(`[${zr.code},${x.code}]`), 'layoutOf sees the change');

  // Back to its own default
  check(await dev.assign(zr.code, zr.code), 'ASSIGN ZR -> ZR (own default) accepted');
  m = Object.fromEntries((await dev.map()).map((e) => [e.name, e]));
  check(m.ZR.gcCur === m.ZR.gcDef, 'ZR back to default');

  // Refusal: Power is the modifier
  check(!(await dev.assign(byName.Power.code, x.code)), 'Power refused by the firmware');

  // A profile: swap two buttons, apply, read back
  const swap = [[zr.code, x.code], [x.code, zr.code]];
  await applyLayout(dev, swap);
  const after = layoutOf(await dev.map());
  check(JSON.stringify(after.sort()) === JSON.stringify(swap.slice().sort()), `profile apply round-trips (${JSON.stringify(after)})`);
} catch (e) {
  console.error('ERROR', e);
  failures++;
} finally {
  if (original) {
    await applyLayout(dev, original);
    const back = layoutOf(await dev.map());
    check(JSON.stringify(back.sort()) === JSON.stringify(original.slice().sort()), `original layout restored (${JSON.stringify(back)})`);
  }
  await dev.close();
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
