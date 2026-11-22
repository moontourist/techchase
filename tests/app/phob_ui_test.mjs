import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_PORT = 8476;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const server = spawn(process.env.PYTHON || 'python', ['-I', join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'app', 'serve.py'),
  '--no-browser', '--port', String(APP_PORT)], { stdio: 'ignore' });
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shots = process.argv[2];
const PORT = 9334;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gcu-phob-'))}`, '--window-size=1360,1000', 'about:blank'], { stdio: 'ignore' });

const FAKE_DESKTOP = `
(() => {
  const listeners = {};
  let channel = null;
  class Channel { constructor() { this.onmessage = null; channel = this; } }
  const BITS = { A: 1, B: 2, X: 4, Y: 8, LEFT: 16, RIGHT: 32, DOWN: 64, UP: 128, START: 256, Z: 512, R: 1024, L: 2048 };
  const state = { main: [128, 128], c: [128, 128], buttons: [], l: 0, r: 0 };
  function report() {
    const r = new Array(37).fill(0);
    r[0] = 0x21;
    const bits = state.buttons.reduce((m, b) => m | BITS[b], 0);
    r.splice(1, 9, 0x10, bits & 0xFF, bits >> 8, state.main[0], state.main[1], state.c[0], state.c[1], state.l, state.r);
    return r;
  }
  setInterval(() => {
    if (!channel?.onmessage) return;
    const batch = [];
    for (let i = 0; i < 8; i++) batch.push(...report());
    channel.onmessage(batch);
  }, 8);
  window.__fake = {
    set(next) { Object.assign(state, next); },
    hold(next, ms) { Object.assign(state, next); return new Promise((r) => setTimeout(r, ms)); },
  };
  window.__TAURI__ = {
    core: {
      Channel,
      async invoke(cmd) {
        if (cmd === 'usb_devices') return [];
        if (cmd === 'adapter_open') return 'Lossless adapter';
        return null;
      },
    },
    event: { listen: async (name, fn) => { listeners[name] = fn; } },
  };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const consoleErrors = [];
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function until(expr, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await js(expr)) return true;
    await sleep(50);
  }
  return false;
}
async function shot(name) {
  if (!shots) return;
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shots, `${name}.png`), Buffer.from(r.data, 'base64'));
}

let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures++; };

const MAX_ANGLE = 0.4886921906;
function target(deg) {
  const a = (deg * Math.PI) / 180;
  const v = (c) => Math.trunc((100 * Math.atan2(Math.sin(MAX_ANGLE) * c, Math.cos(MAX_ANGLE))) / MAX_ANGLE + 127.5);
  return [v(Math.cos(a)), v(Math.sin(a))];
}
const ORDER = [0, 4, 8, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15];
const doText = () => js(`document.querySelector('#phobDo').textContent`);
const hold = (state, ms = 250) => js(`window.__fake.hold(${JSON.stringify(state)}, ${ms})`);

try {
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(100); }
  }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.exception?.description);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_DESKTOP });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(APP)).ok) break; } catch { await sleep(100); }
  }
  await cdp('Page.navigate', { url: APP });
  await until(`!!document.querySelector('#adapterBtn') && document.readyState === 'complete'`);

  check(await js(`!document.querySelector('#welcomeAdapter').hidden`), 'the desktop app offers the adapter on the welcome screen');
  check(await js(`!document.querySelector('#adapterBtn').disabled && document.querySelector('#adapterBrowser').hidden`), 'the desktop app can use the adapter');
  await shot('welcome');
  await js(`document.querySelector('#adapterBtn').click()`);
  check(await until(`document.querySelector('#connStatus').textContent === 'Adapter port 1'`), 'Use adapter opens it and picks the controller in port 1');
  check(await js(`[...document.querySelectorAll('.tabs button')].filter((b) => b.disabled).length === 4`), 'tabs that need a GC Ultimate say so instead of opening');

  await hold({ main: [198, 128] }, 300);
  check(await until(`document.querySelector('#rawL').textContent.includes('70')`), 'the live view shows the stick counted from where it rested at connect');
  check(await js(`document.querySelector('#preL').textContent.includes('not sent')`), 'the value before filtering is marked as not sent by this controller');
  await hold({ main: [128, 128], buttons: ['A'] }, 200);
  check(await until(`document.querySelector('.gcb-a').classList.contains('on')`), 'a pressed button lights in the live view');
  await hold({ buttons: [] }, 100);

  await js(`document.querySelector('#calibL').click()`);
  check(await until(`!document.querySelector('#phobCalib').hidden`), 'Calibrate main stick opens the Phob guide');
  check(await until(`document.querySelector('#phobDo').textContent.startsWith('Turn off safe mode')`), 'it starts by asking for safe mode off');
  await shot('phob-1-start');

  await hold({ buttons: ['A', 'X', 'Y', 'START'] }, 200);
  await hold({ main: [255, 255], c: [255, 255], buttons: [], l: 255, r: 255 }, 2000);
  await hold({ main: [128, 128], c: [128, 128], l: 0, r: 0 }, 200);
  check(await until(`document.querySelector('#phobDo').textContent.startsWith('Press A + X + Y + L')`), 'a 2 s freeze after A+X+Y+Start moves on to A+X+Y+L');

  await hold({ buttons: ['A', 'X', 'Y', 'L'] }, 200);
  await hold({ main: [255, 255], c: [255, 255], buttons: [] }, 2000);
  await hold({ main: [128, 128], c: [127, 127] }, 300);
  check(await until(`document.querySelector('#phobDo').textContent === 'Let go of the stick. Press A.'`), 'measuring starts on the center');
  await shot('phob-2-center');

  for (const [k, n] of ORDER.entries()) {
    if (k === 8) break;
    const [x, y] = target(n * 22.5);
    const a = (n * 22.5 * Math.PI) / 180;
    await hold({ c: [x, y], main: [128 + Math.round(90 * Math.cos(a)), 128 + Math.round(90 * Math.sin(a))] }, 250);
    if (k === 4) {
      check((await doText()) === 'Push the stick into the up-right notch. Hold it there and press A.', 'the up-right point names its notch');
      await shot('phob-3-upright');
    }
    await hold({ c: [127, 127], main: [128, 128] }, 250);
  }
  const [tx, ty] = target(22.5);
  await hold({ c: [tx, ty] }, 300);
  check((await doText()) === 'Let go of the stick. Press A.' && (await js(`document.querySelector('#phobWhy').textContent`)).includes('skipped'), 'a modder-notch point says to let go when the shell has only 8 notches');
  check(await js(`document.querySelector('#phobDo').textContent && [...document.querySelectorAll('#phobSteps li')].findIndex((l) => l.className === 'now') === 2`), 'the steps show measuring as the current step');
  await hold({ c: [127, 127] }, 250);
  for (const n of ORDER.slice(9)) {
    const [x, y] = target(n * 22.5);
    await hold({ c: [x, y] }, 200);
    await hold({ c: [127, 127] }, 200);
  }
  const last = target(337.5);
  await hold({ c: last }, 200);
  const ur = target(44);
  await hold({ c: ur, main: [128 + 57, 128 + 55] }, 400);
  check(await until(`document.querySelector('#phobTitle').textContent.startsWith('Fine-tune the up-right notch')`), 'after 32 points the guide moves to the up-right notch');
  check((await doText()) === 'Tap Y.', 'up-right landing below 45 degrees says to tap Y');
  await shot('phob-4-notch');
  await hold({ main: [128 + 56, 128 + 56] }, 300);
  check((await doText()).startsWith('Perfect'), 'up-right at (0.7000, 0.7000) says on target');
  for (const deg of [136, 225, 314]) await hold({ c: target(deg), main: [128, 128] }, 250);
  await hold({ c: [128, 128] }, 400);
  check(await until(`document.querySelector('#phobTitle').textContent === 'Calibration done'`), 'the c-stick back at center means the Phob saved');
  await shot('phob-5-done');

  await js(`document.querySelector('#phobClose').click()`);
  await js(`document.querySelector('#snapBtn').click()`);
  check(await until(`!document.querySelector('#snap').hidden && !document.querySelector('#snapPhob').hidden`), 'Tune snapback opens the Phob version of the snapback panel');
  check(await until(`document.querySelector('#snapGcu').hidden && document.querySelector('#snapStick').hidden`), 'the GC Ultimate filter controls stay hidden for a Phob');
  for (let i = 0; i < 3; i++) {
    await hold({ main: [228, 128] }, 150);
    await hold({ main: [98, 128] }, 25);
    await hold({ main: [128, 128] }, 150);
  }
  check(await until(`document.querySelector('#snapRows tr').children[1].textContent === '3'`), 'three releases from the right are counted');
  check(await js(`document.querySelector('#snapRows tr').children[2].textContent === '0.3750'`), 'the worst swing shows in Melee units (30 units is 0.3750)');
  check(await js(`document.querySelector('#snapRows tr .verdict').textContent === 'past the deadzone'`), 'a swing of 0.3750 is past the deadzone');
  check(await js(`document.querySelector('#snapAdvice li').textContent.includes('Read your settings')`), 'without the setting, the advice asks to read it');
  await hold({ buttons: ['L'], l: 220 }, 120);
  await hold({ buttons: [], main: [131, 131], c: [127, 127], l: 0 }, 2000);
  await hold({ main: [128, 128], c: [128, 128] }, 200);
  check(await until(`document.querySelector('#snapPhobSettings').textContent.startsWith('Snapback: left/right 4, up/down 4')`), 'L + Start is read back: snapback 4 and 4');
  check(await js(`document.querySelector('#snapAdvice li').textContent.includes('hold A + X and tap D-pad up')`.replace('hold A + X and tap', 'Hold A + X and tap')), 'with the setting known, it says hold A + X and tap D-pad up');
  await shot('snap-1-phob');
  await hold({ buttons: ['A', 'X'] }, 200);
  await hold({ buttons: [], c: [132, 131] }, 750);
  await hold({ buttons: ['A', 'X'], c: [128, 128] }, 100);
  await hold({ buttons: [] }, 100);
  check(await until(`document.querySelector('#snapPhobSettings').textContent.startsWith('Snapback: left/right 5')`), 'tapping A + X + D-pad up is read back as 5');
  check(await js(`document.querySelector('#snapRows tr').children[1].textContent === '0'`), 'a change clears the table so the next test is fresh');
  check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors.join(' | ')}` : ''}`);
} catch (e) {
  check(false, e.message);
} finally {
  chrome.kill();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
