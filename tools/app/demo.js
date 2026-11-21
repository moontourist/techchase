// A stand-in controller for ?demo: the same API as GcuDevice, held in memory, starting from the
// real GC Ultimate's button map (demo-fixture.json). Latency numbers are made up but shaped like the
// measured ones.
import { remappable } from './gcu-protocol.js';

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
  }

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
