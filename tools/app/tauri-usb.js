const tauri = window.__TAURI__;

const CONFIG = {
  configurationValue: 1,
  interfaces: [{
    interfaceNumber: 1,
    alternates: [{
      interfaceClass: 0xFF,
      endpoints: [
        { endpointNumber: 1, direction: 'in', type: 'bulk' },
        { endpointNumber: 1, direction: 'out', type: 'bulk' },
      ],
    }],
  }],
};
const QUEUE_MAX = 256;

const inResult = (pkt) => ({ status: 'ok', data: new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength) });

class DesktopUsbDevice {
  constructor(d) {
    this.id = d.id;
    this.vendorId = d.vendorId;
    this.productId = d.productId;
    this.productName = d.productName;
    this.opened = false;
    this.configuration = null;
    this.queue = [];
    this.waiting = [];
  }

  async open() {
    if (this.opened) return;
    const channel = new tauri.core.Channel();
    channel.onmessage = (bytes) => this._push(new Uint8Array(bytes));
    await tauri.core.invoke('usb_open', { id: this.id, onPacket: channel });
    this.queue = [];
    this.opened = true;
    this.configuration = CONFIG;
  }

  async selectConfiguration() {}
  async claimInterface() {}
  async releaseInterface() {}

  async close() {
    if (!this.opened) return;
    this._end(new DOMException('The device was closed.', 'InvalidStateError'));
    await tauri.core.invoke('usb_close', { id: this.id });
  }

  transferIn() {
    if (this.queue.length) return Promise.resolve(inResult(this.queue.shift()));
    if (!this.opened) return Promise.reject(new DOMException('The device is not open.', 'InvalidStateError'));
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  async transferOut(_endpoint, data) {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    await tauri.core.invoke('usb_send', { id: this.id, data: Array.from(bytes) });
    return { status: 'ok', bytesWritten: bytes.byteLength };
  }

  _push(pkt) {
    if (!this.opened) return;
    const w = this.waiting.shift();
    if (w) w.resolve(inResult(pkt));
    else if (this.queue.length < QUEUE_MAX) this.queue.push(pkt);
  }

  _end(err) {
    this.opened = false;
    this.configuration = null;
    this.queue = [];
    for (const w of this.waiting.splice(0)) w.reject(err);
  }
}

class DesktopUsb extends EventTarget {
  constructor() {
    super();
    this.devices = new Map();
    tauri.event.listen('usb-connect', (e) => this._fire('connect', this._device(e.payload)));
    tauri.event.listen('usb-disconnect', (e) => {
      const dev = this.devices.get(e.payload);
      if (!dev) return;
      this.devices.delete(e.payload);
      dev._end(new DOMException('The device was disconnected.', 'NotFoundError'));
      this._fire('disconnect', dev);
    });
  }

  _device(d) {
    let dev = this.devices.get(d.id);
    if (!dev) {
      dev = new DesktopUsbDevice(d);
      this.devices.set(d.id, dev);
    }
    return dev;
  }

  _fire(type, device) {
    const ev = new Event(type);
    ev.device = device;
    this.dispatchEvent(ev);
  }

  async getDevices() {
    const list = await tauri.core.invoke('usb_devices');
    return list.map((d) => this._device(d));
  }

  async requestDevice({ filters = [] } = {}) {
    const fits = (d) => !filters.length || filters.some((f) => f.vendorId === undefined || f.vendorId === d.vendorId);
    const dev = (await this.getDevices()).find(fits);
    if (!dev) throw new DOMException('No GC Ultimate found. Plug it in over USB (not in Slippi mode).', 'NotFoundError');
    return dev;
  }
}

if (tauri) Object.defineProperty(navigator, 'usb', { value: new DesktopUsb(), configurable: true });
