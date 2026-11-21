import { encodeLive, parseLive, remappable } from './gcu-protocol.js';
import { GC_PER_FW } from './melee.js';

const DEMO_NOTCHES = [[100, 0], [76, 73], [0, 102], [-74, 77], [-101, 0], [-73, -73], [0, -101], [74, -75]];
const STEP_MS = 1200;
const CYCLE_MS = DEMO_NOTCHES.length * STEP_MS + 4400;
const fw = (gc) => (gc + 0.5) / GC_PER_FW;

function demoHand(t) {
  const c = t % CYCLE_MS;
  let pre = [0, 0];
  let game = [0, 0];
  if (c < DEMO_NOTCHES.length * STEP_MS) {
    const [nx, ny] = DEMO_NOTCHES[Math.floor(c / STEP_MS)];
    const k = c % STEP_MS;
    if (k < 250) {
      const e = 1 - (1 - k / 250) ** 3;
      pre = [nx * e, ny * e];
      game = pre;
    } else if (k < 850) {
      pre = [nx, ny];
      game = pre;
    } else {
      const s = (k - 850) / 1000;
      const w = Math.exp(-s / 0.035) * Math.cos(2 * Math.PI * 24 * s) * -0.42;
      pre = [nx * w, ny * w];
      game = pre.map((v) => (Math.abs(v) < 20 ? 0 : v * 0.5));
    }
  } else {
    const a = ((c - DEMO_NOTCHES.length * STEP_MS) / 4400) * 2 * Math.PI;
    const r = 99 + 3 * Math.cos(4 * a);
    pre = [r * Math.cos(a), r * Math.sin(a)];
    game = pre;
  }
  const ca = (t / 2000) * 2 * Math.PI;
  const tri = 1 - Math.abs(((t / 1500) % 2) - 1);
  const presses = [];
  if (t % 1700 < 150) presses.push(0);
  if (t % 3100 < 200) presses.push(9);
  if (tri > 0.97) presses.push(10);
  return {
    game: { lx: fw(game[0]), ly: fw(game[1]), rx: fw(70 * Math.cos(ca)), ry: fw(70 * Math.sin(ca)) },
    pre: { lx: fw(pre[0]), ly: fw(pre[1]), rx: fw(70 * Math.cos(ca)), ry: fw(70 * Math.sin(ca)) },
    presses,
    lt: Math.round(tri * 4095),
    rt: 0,
  };
}

export async function makeDemoDevice() {
  const fixture = await (await fetch('demo-fixture.json')).json();
  return new DemoDevice(fixture);
}

class DemoDevice {
  constructor(fixture) {
    this.fixture = fixture;
    this.entries = fixture.map.map((e) => ({ ...e }));
    this.latchOn = true;
    this.reportFormat = 6;
    this.t0 = performance.now();
    this.productName = `${fixture.product} (demo)`;
    this.vendorId = 0x2E8A;
    this.productId = 0x10C6;
    this.demo = true;
    this.liveFns = new Set();
    this.liveTimer = null;
    this.seq = 0;
  }

  onLive(fn) {
    this.liveFns.add(fn);
    if (!this.liveTimer) {
      this.liveTimer = setInterval(() => {
        const pkt = encodeLive({ ...demoHand(performance.now() - this.t0), seq: this.seq++ });
        const rep = parseLive(pkt);
        for (const f of this.liveFns) f(rep);
      }, 8);
    }
    return () => {
      this.liveFns.delete(fn);
      if (!this.liveFns.size) { clearInterval(this.liveTimer); this.liveTimer = null; }
    };
  }

  async setLiveMode() {}

  async open() {}
  async close() {}
  async deviceInfo() { return { ...this.fixture.device }; }
  async info() { return { techchase: true, proto: 1, latchOn: this.latchOn, latchMode: this.latchOn ? 2 : 1, reportFormat: this.reportFormat, quickRemap: false }; }
  async resetStats() { this.t0 = performance.now(); }
  async setLatch(on) { this.latchOn = on; this.t0 = performance.now(); }

  async stats() {
    const secs = Math.max(0.05, (performance.now() - this.t0) / 1000);
    const count = Math.round(secs * (940 + Math.random() * 15));
    const j = () => Math.random() * 30;
    const s = this.latchOn
      ? { ageAvgUs: 352 + j(), ageMinUs: 233 + j(), ageMaxUs: 410 + j() }
      : { ageAvgUs: 930 + j(), ageMinUs: 860 + j(), ageMaxUs: 1900 + 900 * Math.random() };
    return {
      version: 1, mode: this.latchOn ? 2 : 1, latchOff: !this.latchOn, guardUs: 125, count, misses: 0,
      phaseUs: 74, leadUs: 415, readUs: 73, readMaxUs: 84,
      ageAvgUs: Math.round(s.ageAvgUs), ageMinUs: Math.round(s.ageMinUs), ageMaxUs: Math.round(s.ageMaxUs),
    };
  }

  async map() {
    await new Promise((r) => setTimeout(r, 60));
    return this.entries.map((e) => ({ ...e }));
  }

  async assign(src, target) {
    const ok = remappable(this.entries);
    const s = ok.find((e) => e.code === src);
    const t = ok.find((e) => e.code === target);
    if (!s || !t) return false;
    s.gcCur = t.gcDef;
    s.swCur = t.swDef;
    return true;
  }

  async resetAll() {
    for (const e of this.entries) { e.gcCur = e.gcDef; e.swCur = e.swDef; }
  }

  async setUsbMode(id) { this.reportFormat = id; return true; }

  async backup() {
    return { product: this.productName, board: this.fixture.device.name, fw_version: this.fixture.device.fwVersion, saved: new Date().toISOString(), demo: true, config: {}, static: {} };
  }
}
