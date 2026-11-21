export const ID_READ_CONFIG_BLOCK = 0x01;
export const ID_READ_STATIC_BLOCK = 0x03;
export const ID_INPUT_COMMAND = 0x05;
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

export const DIGITAL_GC = new Set(['A', 'B', 'X', 'Y', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'Z', 'L', 'R', 'ZL',
  'MINUS', 'HOME', 'CAPTURE', 'C', 'LS', 'RS']);

export const LIVE = { TECHCHASE: 253, JOYSTICKS: 254, RAW: 255 };
export const INPUT = { L: 10, LT_ANALOG: 11, R: 12, RT_ANALOG: 13, LX_RIGHT: 27, LX_LEFT: 28, LY_UP: 29, LY_DOWN: 30,
  RX_RIGHT: 32, RX_LEFT: 33, RY_UP: 34, RY_DOWN: 35 };
const INPUT_CODES = 36;

const u16be = (p, o) => (p[o] << 8) | p[o + 1];
const sticksAt = (p, o) => ({ lx: u16be(p, o) - 2048, ly: u16be(p, o + 2) - 2048, rx: u16be(p, o + 4) - 2048, ry: u16be(p, o + 6) - 2048 });

export function parseLive(p) {
  if (!p || p.length < 41) return null;
  if (p[0] === LIVE.TECHCHASE) {
    const presses = new Set();
    for (let i = 0; i < INPUT_CODES; i++) if (p[31 + (i >> 3)] & (1 << (i & 7))) presses.add(i);
    return { full: true, game: sticksAt(p, 15), pre: sticksAt(p, 23), presses, lt: u16be(p, 36), rt: u16be(p, 38), seq: p[40] };
  }
  if (p[0] === LIVE.JOYSTICKS) {
    return { full: false, game: sticksAt(p, 23), pre: sticksAt(p, 15), presses: new Set(), lt: 0, rt: 0, seq: null };
  }
  if (p[0] === LIVE.RAW) {
    const v = (code) => (p[17 + code] & 0x7F) << 5;
    const presses = new Set();
    for (let i = 0; i < INPUT_CODES; i++) if (p[17 + i] & 0x80) presses.add(i);
    const half = (pos, neg) => (v(pos) - v(neg)) / 2;
    const game = { lx: half(INPUT.LX_RIGHT, INPUT.LX_LEFT), ly: half(INPUT.LY_UP, INPUT.LY_DOWN),
      rx: half(INPUT.RX_RIGHT, INPUT.RX_LEFT), ry: half(INPUT.RY_UP, INPUT.RY_DOWN) };
    return { full: false, game, pre: game, presses, lt: v(INPUT.LT_ANALOG), rt: v(INPUT.RT_ANALOG), seq: null };
  }
  return null;
}

export function encodeLive({ game, pre, presses = [], lt = 0, rt = 0, seq = 0 }) {
  const p = new Uint8Array(64);
  const put = (o, v) => { const c = Math.max(0, Math.min(0xFFFF, Math.round(v) + 2048)); p[o] = c >> 8; p[o + 1] = c & 0xFF; };
  const putSticks = (o, s) => { put(o, s.lx); put(o + 2, s.ly); put(o + 4, s.rx); put(o + 6, s.ry); };
  p[0] = LIVE.TECHCHASE;
  putSticks(15, game);
  putSticks(23, pre ?? game);
  for (const c of presses) if (c >= 0 && c < INPUT_CODES) p[31 + (c >> 3)] |= 1 << (c & 7);
  put(36, lt - 2048);
  put(38, rt - 2048);
  p[40] = seq & 0xFF;
  return p;
}

export const codeName = (table, c) => (c == null || c < 0 || c === 0xFF) ? null : (table[c] ?? `#${c}`);
const s8 = (b) => (b > 127 ? b - 256 : b);

export class TimeoutError extends Error {}

export class GcuDevice {
  constructor(usbDevice) {
    this.dev = usbDevice;
    this.waiters = [];
    this.reading = false;
    this.closed = false;
    this.queue = Promise.resolve();
    this.liveListeners = new Set();
  }

  onLive(fn) {
    this.liveListeners.add(fn);
    return () => this.liveListeners.delete(fn);
  }

  setLiveMode(mode) {
    return this._run(() => this._send([ID_INPUT_COMMAND, 0, mode]));
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
    try { await this.dev.releaseInterface(this.itf); } catch {  }
    try { await this.dev.close(); } catch {  }
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
        if (pkt[0] >= LIVE.TECHCHASE) {
          if (this.liveListeners.size) {
            const rep = parseLive(pkt);
            if (rep) for (const fn of this.liveListeners) fn(rep);
          }
          continue;
        }
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
        if (p[2] > p.length - 4) throw new Error(`settings block ${block}: a chunk says ${p[2]} bytes, the packet holds ${p.length - 4}`);
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
    if (r.length < 42) throw new Error(`latency stats: ${r.length} bytes, 42 expected`);
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
      if (4 + count * 13 > r.length) throw new Error(`map page ${page}: ${count} entries don't fit in ${r.length} bytes`);
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

export function remappable(entries) {
  return entries.filter((e) => e.name !== 'Power' && DIGITAL_GC.has(codeName(GC_CODES, e.gcDef)));
}

export function jobs(entries) {
  const seen = new Map();
  for (const e of remappable(entries)) {
    if (!seen.has(e.gcDef)) seen.set(e.gcDef, { target: e.code, gc: e.gcDef, sw: e.swDef, from: e.name });
  }
  return [...seen.values()];
}

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
