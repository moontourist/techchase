// techchase protocol over WebUSB. The same module runs in the browser (navigator.usb) and in
// Node (the `usb` package's WebUSB), so the tests drive the controller with the page's own code.
//
// The controller's config interface (vendor class, two bulk endpoints) takes 64-byte packets.
// Replies come back on its IN endpoint; one reader loop hands each to whoever is waiting for it.

export const ID_READ_CONFIG_BLOCK = 0x01;
export const ID_READ_STATIC_BLOCK = 0x03;
export const ID_TECHCHASE = 0xC0;

export const T = { INFO: 0, STATS: 1, STATS_RESET: 2, LATCH: 3, ASSIGN: 4, RESET_ALL: 5, MAP: 6, USB_MODE: 7 };

export const GC_CODES = ['A', 'B', 'X', 'Y', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'Z', 'L', 'R', 'L_ANALOG',
  'R_ANALOG', 'LX_RIGHT', 'LX_LEFT', 'LY_UP', 'LY_DOWN', 'RX_RIGHT', 'RX_LEFT', 'RY_UP', 'RY_DOWN', 'ZL', 'MINUS',
  'HOME', 'CAPTURE', 'C', 'LS', 'RS'];
export const SW_CODES = ['A', 'B', 'X', 'Y', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'L', 'R', 'ZL', 'ZR', 'PLUS', 'MINUS',
  'HOME', 'CAPTURE', 'LS', 'RS', 'LX_RIGHT', 'LX_LEFT', 'LY_UP', 'LY_DOWN', 'RX_RIGHT', 'RX_LEFT', 'RY_UP', 'RY_DOWN',
  'FLICK_UP', 'FLICK_DOWN', 'FLICK_LEFT', 'FLICK_RIGHT'];

export const FORMATS = { 0: 'Switch Pro', 1: 'XInput', 2: 'Slippi (GC adapter)', 3: 'GameCube port', 4: 'N64',
  5: 'SNES', 6: 'SInput', 7: 'Wii' };
export const MODE_IDS = { switch: 0, slippi: 2, sinput: 6 };
export const LATCH_MODES = {
  0: 'Off',
  1: 'Learning the host’s timing (stock timing meanwhile)',
  2: 'Late-latch active',
  3: 'Polls not steady (stock timing)',
  4: 'Poll-locked',
};

// GameCube outputs a physical button can be given (digital ones)
export const DIGITAL_GC = new Set(['A', 'B', 'X', 'Y', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'Z', 'L', 'R', 'ZL',
  'MINUS', 'HOME', 'CAPTURE', 'C', 'LS', 'RS']);

export const codeName = (table, c) => (c == null || c < 0 || c === 0xFF) ? null : (table[c] ?? `#${c}`);
const s8 = (b) => (b > 127 ? b - 256 : b);

export class TimeoutError extends Error {}

export class GcuDevice {
  constructor(usbDevice) {
    this.dev = usbDevice;
    this.waiters = [];
    this.reading = false;
    this.closed = false;
    this.queue = Promise.resolve(); // one command at a time
  }

  get productName() { return this.dev.productName; }
  get vendorId() { return this.dev.vendorId; }
  get productId() { return this.dev.productId; }

  async open() {
    const d = this.dev;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    for (const itf of d.configuration.interfaces) {
      const alt = itf.alternates[0];
      if (alt.interfaceClass !== 0xFF) continue;
      const bulk = alt.endpoints.filter((e) => e.type === 'bulk');
      const epIn = bulk.find((e) => e.direction === 'in');
      const epOut = bulk.find((e) => e.direction === 'out');
      if (epIn && epOut) {
        this.itf = itf.interfaceNumber;
        this.epIn = epIn.endpointNumber;
        this.epOut = epOut.endpointNumber;
        break;
      }
    }
    if (this.itf === undefined)
      throw new Error('This device has no config interface. In Slippi mode it only has one when the app or gcu.py switched it there.');
    await d.claimInterface(this.itf);
    this.closed = false;
    this._readLoop();
  }

  async close() {
    this.closed = true;
    for (const w of this.waiters) w.reject(new Error('closed'));
    this.waiters = [];
    try { await this.dev.releaseInterface(this.itf); } catch { /* gone already */ }
    try { await this.dev.close(); } catch { /* gone already */ }
  }

  async _readLoop() {
    if (this.reading) return;
    this.reading = true;
    try {
      while (!this.closed) {
        let r;
        try {
          r = await this.dev.transferIn(this.epIn, 64);
        } catch (e) {
          if (this.closed) break;
          for (const w of this.waiters) w.reject(e);
          this.waiters = [];
          break;
        }
        if (!r.data || r.data.byteLength === 0) continue;
        const pkt = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        const i = this.waiters.findIndex((w) => w.match(pkt));
        if (i >= 0) {
          const [w] = this.waiters.splice(i, 1);
          w.resolve(pkt.slice());
        }
      }
    } finally {
      this.reading = false;
    }
  }

  _wait(match, ms) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new TimeoutError('no reply from the controller')); }
      }, ms);
    });
  }

  async _send(bytes) {
    const out = new Uint8Array(64);
    out.set(bytes);
    await this.dev.transferOut(this.epOut, out);
  }

  // Commands are serialized: a reply is matched by its id and sub-command only
  _run(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  command(sub, ...args) {
    return this._run(async () => {
      const reply = this._wait((p) => p[0] === ID_TECHCHASE && p[1] === sub, 1500);
      await this._send([ID_TECHCHASE, sub, ...args]);
      return reply;
    });
  }

  readBlock(readId, block) {
    return this._run(async () => {
      const chunks = [];
      const first = this._wait((p) => p[0] === readId && p[1] === block, 1500);
      await this._send([readId, block]);
      let p = await first;
      while (p[3] !== 0xFF) {
        chunks.push(p.slice(4, 4 + p[2]));
        p = await this._wait((q) => q[0] === readId && q[1] === block, 1500);
      }
      const len = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(len);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    });
  }

  // --- High level ---

  async deviceInfo() {
    const blk = await this.readBlock(ID_READ_STATIC_BLOCK, 0);
    const name = new TextDecoder().decode(blk.slice(0, 16)).replace(/\0.*$/s, '');
    const fw = blk.length >= 708 ? new DataView(blk.buffer, blk.byteOffset).getUint32(704, true) : null;
    return { name, fwVersion: fw };
  }

  async info() {
    let r;
    try {
      r = await this.command(T.INFO);
    } catch (e) {
      if (e instanceof TimeoutError) return { techchase: false };
      throw e;
    }
    return { techchase: true, proto: r[2], latchOn: !!r[3], latchMode: r[4], reportFormat: r[5], quickRemap: !!r[6] };
  }

  async stats() {
    const r = await this.command(T.STATS);
    const v = new DataView(r.buffer, r.byteOffset + 2);
    const u32 = (o) => v.getUint32(o, true);
    return {
      version: v.getUint8(0), mode: v.getUint8(1) & 0x7F, latchOff: !!(v.getUint8(1) & 0x80), guardUs: v.getUint16(2, true),
      count: u32(4), ageMinUs: u32(8), ageMaxUs: u32(12), ageAvgUs: u32(16), misses: u32(20), phaseUs: u32(24),
      leadUs: u32(28), readUs: u32(32), readMaxUs: u32(36),
    };
  }

  resetStats() { return this.command(T.STATS_RESET); }
  setLatch(on) { return this.command(T.LATCH, on ? 1 : 0); }

  async map() {
    const entries = [];
    for (let page = 0; page < 16; page++) {
      const r = await this.command(T.MAP, page);
      const count = r[3];
      for (let i = 0; i < count; i++) {
        const e = r.subarray(4 + i * 13, 4 + (i + 1) * 13);
        if (e[0] === 0xFF) continue;
        entries.push({
          code: e[0], gcCur: s8(e[1]), gcDef: s8(e[2]), swCur: s8(e[3]), swDef: s8(e[4]),
          name: new TextDecoder().decode(e.slice(5, 13)).replace(/\0.*$/s, ''),
        });
      }
      if (count === 0) break;
    }
    return entries;
  }

  async assign(src, target) {
    const r = await this.command(T.ASSIGN, src, target);
    return !!r[2];
  }

  resetAll() { return this.command(T.RESET_ALL); }

  async setUsbMode(id) {
    const r = await this.command(T.USB_MODE, id);
    return !!r[2];
  }

  async backup() {
    const { name, fwVersion } = await this.deviceInfo();
    const out = { product: this.productName, board: name, fw_version: fwVersion, saved: new Date().toISOString(), config: {}, static: {} };
    const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
    for (let b = 0; b < 16; b++) {
      let blk;
      try { blk = await this.readBlock(ID_READ_CONFIG_BLOCK, b); } catch { break; }
      out.config[b] = hex(blk);
    }
    for (let b = 0; b < 16; b++) {
      let blk;
      try { blk = await this.readBlock(ID_READ_STATIC_BLOCK, b); } catch { break; }
      out.static[b] = hex(blk);
    }
    return out;
  }
}

// --- Layouts (what the app and profiles work with) ---

// Buttons that can be remapped: digital, and not the board's modifier (Power), which the firmware
// refuses
export function remappable(entries) {
  return entries.filter((e) => e.name !== 'Power' && DIGITAL_GC.has(codeName(GC_CODES, e.gcDef)));
}

// Jobs: each remappable button's default GameCube output, given by sending that button as target
export function jobs(entries) {
  const seen = new Map();
  for (const e of remappable(entries)) {
    if (!seen.has(e.gcDef)) seen.set(e.gcDef, { target: e.code, gc: e.gcDef, sw: e.swDef, from: e.name });
  }
  return [...seen.values()];
}

// The layout as [src, target] pairs for every changed button
export function layoutOf(entries) {
  const byDef = new Map(remappable(entries).map((e) => [e.gcDef, e.code]));
  const out = [];
  for (const e of remappable(entries)) {
    if (e.gcCur === e.gcDef) continue;
    const t = byDef.get(e.gcCur);
    if (t !== undefined) out.push([e.code, t]);
  }
  return out;
}

export async function applyLayout(dev, pairs) {
  await dev.resetAll();
  for (const [s, t] of pairs) {
    if (!(await dev.assign(s, t))) throw new Error(`the controller refused remapping input ${s}`);
  }
}
