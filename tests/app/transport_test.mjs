import { GcuDevice, ID_READ_CONFIG_BLOCK } from '../../tools/app/gcu-protocol.js';

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const BLOCK = 2;
const SIZE = 1024;
const CHUNK = 32;
const stored = Uint8Array.from({ length: SIZE }, (_, i) => (i * 7 + 3) & 0xFF);

class QueuedDevice {
  constructor() {
    this.productName = 'fake';
    this.vendorId = 0x2E8A;
    this.productId = 0x10C6;
    this.opened = false;
    this.configuration = null;
    this.queue = [];
    this.waiting = [];
    this.written = null;
    this.incoming = [];
  }
  async open() {
    this.opened = true;
    this.configuration = { interfaces: [{ interfaceNumber: 1, alternates: [{ interfaceClass: 0xFF, endpoints: [{ endpointNumber: 1, direction: 'in', type: 'bulk' }, { endpointNumber: 1, direction: 'out', type: 'bulk' }] }] }] };
  }
  async selectConfiguration() {}
  async claimInterface() {}
  async releaseInterface() {}
  async close() { this.opened = false; }
  packet(bytes) {
    const p = new Uint8Array(64);
    p.set(bytes);
    const w = this.waiting.shift();
    if (w) w(p);
    else this.queue.push(p);
  }
  transferIn() {
    const done = (p) => ({ status: 'ok', data: new DataView(p.buffer) });
    if (this.queue.length) return Promise.resolve(done(this.queue.shift()));
    return new Promise((resolve) => this.waiting.push((p) => resolve(done(p))));
  }
  async transferOut(_ep, data) {
    const p = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (p[0] === ID_READ_CONFIG_BLOCK) {
      for (let at = 0, part = 0; at < SIZE; at += CHUNK, part++) this.queue.push(Uint8Array.from([ID_READ_CONFIG_BLOCK, p[1], CHUNK, part, ...stored.subarray(at, at + CHUNK), ...new Array(64 - 4 - CHUNK).fill(0)]));
      this.queue.push(Uint8Array.from([ID_READ_CONFIG_BLOCK, p[1], 0, 0xFF, ...new Array(60).fill(0)]));
      const w = this.waiting.shift();
      if (w) w(this.queue.shift());
    }
    return { status: 'ok', bytesWritten: p.byteLength };
  }
}

const usb = new QueuedDevice();
const dev = new GcuDevice(usb);
await dev.open();
let ok = 0;
let err = null;
for (let i = 0; i < 5; i++) {
  try {
    const b = await dev.readBlock(ID_READ_CONFIG_BLOCK, BLOCK);
    if (b.length === SIZE && b.every((x, j) => x === stored[j])) ok++;
  } catch (e) {
    err = e;
  }
}
check(ok === 5, `a block read whole when every chunk is already queued (${ok} of 5${err ? `, ${err.message}` : ''})`);
let refused = false;
try {
  await dev.writeBlock(BLOCK, stored.subarray(0, SIZE - CHUNK));
} catch {
  refused = true;
}
check(refused, 'a short analog block is never written');
await dev.close();

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
