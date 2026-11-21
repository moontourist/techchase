import { WebUSB } from 'usb';
import { GcuDevice } from '../../tools/app/gcu-protocol.js';
const d = (await new WebUSB({ allowAllDevices: true }).getDevices()).find((x) => x.vendorId === 0x057E || x.vendorId === 0x2E8A);
const g = new GcuDevice(d); await g.open();
const out = { product: g.productName, device: await g.deviceInfo(), map: await g.map() };
await g.close();
console.log(JSON.stringify(out));
