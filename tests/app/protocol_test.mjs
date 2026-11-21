import { WebUSB } from 'usb';
import {
  GcuDevice, ID_READ_CONFIG_BLOCK, GC_CODES, codeName, remappable, jobs, layoutOf, applyLayout, FORMATS, LATCH_MODES,
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
  check(info.techchase && info.proto === 2, 'techchase INFO reply, protocol 2');
  check(info.unsaved === false, 'nothing unsaved at the start');

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

  check(await dev.assign(zr.code, x.code), 'ASSIGN ZR -> X accepted');
  let m = Object.fromEntries((await dev.map()).map((e) => [e.name, e]));
  check(codeName(GC_CODES, m.ZR.gcCur) === 'X' && m.ZR.swCur === x.swDef, 'ZR now jumps in GameCube and Switch profiles');
  check(JSON.stringify(layoutOf(Object.values(m))).includes(`[${zr.code},${x.code}]`), 'layoutOf sees the change');

  check(await dev.assign(zr.code, zr.code), 'ASSIGN ZR -> ZR (own default) accepted');
  m = Object.fromEntries((await dev.map()).map((e) => [e.name, e]));
  check(m.ZR.gcCur === m.ZR.gcDef, 'ZR back to default');

  check(!(await dev.assign(byName.Power.code, x.code)), 'Power refused by the firmware');

  check(await dev.assign(zr.code, x.code, { save: false }), 'ASSIGN ZR -> X without saving accepted');
  m = Object.fromEntries((await dev.map()).map((e) => [e.name, e]));
  check(codeName(GC_CODES, m.ZR.gcCur) === 'X', 'the unsaved change is live');
  check((await dev.info()).unsaved === true, 'INFO reports unsaved changes');
  await dev.revert();
  m = Object.fromEntries((await dev.map()).map((e) => [e.name, e]));
  check(m.ZR.gcCur === m.ZR.gcDef, 'REVERT puts ZR back to the saved layout');
  check((await dev.info()).unsaved === false, 'nothing unsaved after REVERT');

  await dev.resetAll({ save: false });
  check((await dev.info()).unsaved === true, 'RESET_ALL without saving leaves changes unsaved');
  await dev.revert();
  check(JSON.stringify(layoutOf(await dev.map()).sort()) === JSON.stringify(original.slice().sort()), 'REVERT after RESET_ALL brings the saved layout back');

  check(await dev.assign(zr.code, x.code, { save: false }), 'ASSIGN ZR -> X without saving, again');
  await dev.save();
  check((await dev.info()).unsaved === false, 'SAVE clears the unsaved flag');
  await dev.revert();
  m = Object.fromEntries((await dev.map()).map((e) => [e.name, e]));
  check(codeName(GC_CODES, m.ZR.gcCur) === 'X', 'a saved change survives REVERT');

  const swap = [[zr.code, x.code], [x.code, zr.code]];
  await applyLayout(dev, swap);
  const after = layoutOf(await dev.map());
  check(JSON.stringify(after.sort()) === JSON.stringify(swap.slice().sort()), `profile apply round-trips (${JSON.stringify(after)})`);

  const { ANALOG_CMD, CFG_BLOCK_ANALOG, parseAnalog } = await import('../../tools/app/calibration.js');
  const analog = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
  const a = parseAnalog(analog);
  check(analog.length === 1024 && a.l.filter((x) => x.enabled).length >= 8, `analog block reads (${a.l.filter((x) => x.enabled).length} notches on the main stick, calibrated ${a.calibrationSet})`);
  const capL = await dev.captureStick(ANALOG_CMD.CAPTURE_LEFT);
  const capR = await dev.captureStick(ANALOG_CMD.CAPTURE_RIGHT);
  check([capL.angle, capL.distance, capR.angle, capR.distance].every(Number.isFinite) && capL.angle >= 0 && capL.angle < 360,
    `stick capture replies (main ${capL.angle.toFixed(1)}° ${capL.distance.toFixed(0)}, c ${capR.angle.toFixed(1)}° ${capR.distance.toFixed(0)})`);
  await dev.writeBlock(CFG_BLOCK_ANALOG, analog);
  const again = await dev.readBlock(ID_READ_CONFIG_BLOCK, CFG_BLOCK_ANALOG);
  check(again.every((b, i) => b === analog[i]), 'writing the analog block back leaves it byte for byte the same');
  check((await dev.info()).unsaved === false, 'a block write alone does not mark remaps unsaved');
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
