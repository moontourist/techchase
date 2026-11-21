// Draws the README banner with headless Chrome over the DevTools protocol, so the image is
// exactly 960x260 at 2x on every OS (a --screenshot run loses part of the height to the
// window frame on Windows).
// Run from the repo root: node assets/render.mjs   (set CHROME=/path/to/chrome if needed)
// Writes assets/logo.png. Needs Node 22 or later (global fetch and WebSocket).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chromePath = process.env.CHROME ?? (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const PORT = 9334;

// Dracula, the app's own colors: background, foreground brackets, pink tc, purple title.
const C = { bg: '#282a36', text: '#f8f8f2', dim: '#909cbc', inner: '#ff79c6', title: '#bd93f9' };
const font = pathToFileURL(join(root, 'tools', 'app', 'fonts', 'JetBrainsMono.ttf')).href;
const FONT = '"JetBrains Mono", ui-monospace, Menlo, monospace';

// The mark: [tc], the way thunk's is [*], seethe's is [s] and tascii's is [x].
const mark = `<span>[</span><b style="color:${C.inner}">tc</b><span>]</span>`;

const [w, h] = [960, 260];
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:"JetBrains Mono";src:url("${font}") format("truetype");font-weight:100 800}
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${C.bg};font-family:${FONT}}</style>
<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:56px">
  <div style="font-size:120px;font-weight:800;color:${C.text};letter-spacing:-0.04em;line-height:1">${mark}</div>
  <div style="display:flex;flex-direction:column;gap:14px">
    <div style="font-size:64px;font-weight:800;color:${C.title};letter-spacing:-0.02em;line-height:1">techchase</div>
    <div style="font-size:20px;color:${C.dim}">tournament firmware for the GC Ultimate</div>
  </div>
</div>`;

const tmp = mkdtempSync(join(tmpdir(), 'techchase-render-'));
const file = join(tmp, 'logo.html');
writeFileSync(file, html);
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmp, 'profile')}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let next = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  next += 1;
  pending.set(next, { resolve, reject });
  ws.send(JSON.stringify({ id: next, method, params }));
});

let failed = false;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {
      await sleep(100);
    }
  }
  if (!target) throw new Error('Chrome did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: pathToFileURL(file).href });
  await sleep(800);
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  writeFileSync(join(root, 'assets', 'logo.png'), Buffer.from(shot.data, 'base64'));
  console.log('wrote assets/logo.png');
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  ws?.close();
  chrome.kill();
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
