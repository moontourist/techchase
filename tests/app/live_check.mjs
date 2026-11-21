// Reads the live report from a real controller for two seconds and prints what came in.
//   node tests/app/live_check.mjs
import { WebUSB } from 'usb';
import { GcuDevice, LIVE } from '../../tools/app/gcu-protocol.js';
import { gcAxis } from '../../tools/app/melee.js';

const usb = new WebUSB({ allowAllDevices: true });
const dev = (await usb.getDevices()).find((d) => (d.vendorId === 0x057E || d.vendorId === 0x2E8A)
  && d.configuration?.interfaces.some((i) => i.alternates[0].interfaceClass === 0xFF));
if (!dev) { console.error('no techchase controller with a config interface'); process.exit(1); }
const pad = new GcuDevice(dev);
await pad.open();
const reps = [];
const off = pad.onLive((r) => reps.push(r));
await pad.info();
await pad.setLiveMode(LIVE.TECHCHASE);
await new Promise((r) => setTimeout(r, 2000));
off();
const full = reps.filter((r) => r.full);
let drops = 0;
for (let i = 1; i < full.length; i++) drops += (full[i].seq - full[i - 1].seq - 1 + 256) % 256;
const last = full.at(-1) ?? reps.at(-1);
console.log(`reports: ${reps.length} in 2 s, full precision: ${full.length}, dropped: ${drops}`);
if (last) {
  const g = last.game;
  console.log(`main stick at rest: (${gcAxis(g.lx)}, ${gcAxis(g.ly)})  c-stick: (${gcAxis(g.rx)}, ${gcAxis(g.ry)})  firmware units (${g.lx}, ${g.ly})`);
  console.log(`triggers L ${last.lt} R ${last.rt}  pressed codes: [${[...last.presses].join(', ')}]`);
}
await pad.close();
process.exit(full.length > 100 ? 0 : 1);
