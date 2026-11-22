export const REPORT_LEN = 37;
const REPORT_ID = 0x21;
const PORTS = 4;
const BITS = [['A', 1], ['B', 2], ['X', 4], ['Y', 8], ['LEFT', 16], ['RIGHT', 32], ['DOWN', 64], ['UP', 128], ['START', 256], ['Z', 512], ['R', 1024], ['L', 2048]];

export function parseAdapterReport(r, at = 0) {
  if (r.length !== REPORT_LEN || r[0] !== REPORT_ID) return null;
  const ports = [];
  for (let i = 0; i < PORTS; i++) {
    const o = 1 + i * 9;
    const bits = r[o + 1] | (r[o + 2] << 8);
    ports.push({
      connected: (r[o] >> 4) !== 0,
      buttons: new Set(BITS.filter(([, m]) => bits & m).map(([n]) => n)),
      main: { x: r[o + 3], y: r[o + 4] },
      c: { x: r[o + 5], y: r[o + 6] },
      l: r[o + 7],
      r: r[o + 8],
      at,
    });
  }
  return ports;
}

export function liveReport(p, origin) {
  const game = { lx: p.main.x - origin.lx, ly: p.main.y - origin.ly, rx: p.c.x - origin.rx, ry: p.c.y - origin.ry };
  return { gc: true, full: true, game, pre: game, buttons: p.buttons, lt: p.l, rt: p.r, seq: null };
}

export const originOf = (p) => ({ lx: p.main.x, ly: p.main.y, rx: p.c.x, ry: p.c.y });

export class AdapterPad {
  constructor() {
    this.port = null;
    this.origin = null;
    this.wasConnected = [false, false, false, false];
    this.listeners = new Set();
    this.portListeners = new Set();
    this.name = 'GameCube adapter';
    this.last = null;
  }

  onReading(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onPorts(fn) { this.portListeners.add(fn); return () => this.portListeners.delete(fn); }

  async open() {
    const tauri = window.__TAURI__;
    const channel = new tauri.core.Channel();
    channel.onmessage = (bytes) => this.batch(new Uint8Array(bytes), performance.now());
    this.name = await tauri.core.invoke('adapter_open', { onReports: channel });
  }

  async close() {
    this.listeners.clear();
    this.portListeners.clear();
    await window.__TAURI__.core.invoke('adapter_close');
  }

  usePort(i) {
    this.port = i;
    this.origin = this.last?.[i]?.connected ? originOf(this.last[i]) : null;
  }

  recenter() {
    if (this.port !== null && this.last?.[this.port]?.connected) this.origin = originOf(this.last[this.port]);
  }

  connectedPorts() { return (this.last || []).flatMap((p, i) => (p.connected ? [i] : [])); }

  batch(bytes, now) {
    const n = Math.floor(bytes.length / REPORT_LEN);
    for (let k = 0; k < n; k++) {
      const ports = parseAdapterReport(bytes.subarray(k * REPORT_LEN, (k + 1) * REPORT_LEN), now - (n - 1 - k));
      if (ports) this.feed(ports);
    }
  }

  feed(ports) {
    const changed = !this.last || ports.some((p, i) => p.connected !== this.wasConnected[i]);
    if (this.port !== null) {
      const p = ports[this.port];
      if (p.connected && (!this.wasConnected[this.port] || !this.origin)) this.origin = originOf(p);
      if (!p.connected) this.origin = null;
    }
    this.wasConnected = ports.map((p) => p.connected);
    this.last = ports;
    if (changed) for (const fn of this.portListeners) fn(this.connectedPorts());
    if (this.port === null || !this.origin) return;
    const p = ports[this.port];
    for (const fn of this.listeners) fn(p, liveReport(p, this.origin));
  }
}
