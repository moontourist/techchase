import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'http://127.0.0.1:8474/';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shots = process.argv[2];
const PORT = 9333;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'gcu-ui-'))}`, '--window-size=1360,1000', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const events = [];
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

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(100); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method) events.push(msg);
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `${APP}?demo` });

  check(await until(`document.querySelectorAll('#rows li').length > 10`), 'demo controller connects and lists buttons');

  check(await js(`!document.querySelector('#tab-live').hidden`), 'live tab opens first');
  check(await until(`parseInt(document.querySelector('#liveRate').textContent) > 60`, 3000), 'live reports stream in (over 60 a second)');
  check(await until(`/\\d/.test(document.querySelector('#rawL').textContent) && /\\d/.test(document.querySelector('#melL').textContent)`), 'main stick shows raw and Melee coordinates');
  check(await until(`document.querySelector('#trigLVal').textContent.trim() !== '--'`), 'L trigger shows a value');
  check(await until(`document.querySelectorAll('#notchRows td.ok, #notchRows td.near, #notchRows td.off').length === 8`, 14000), 'all eight notches measured');
  check(await js(`[...document.querySelectorAll('#notchRows tr')].some(tr => /Up-right/.test(tr.textContent) && /76,\\s+73/.test(tr.textContent) && /0\\.7125,\\s+0\\.6875/.test(tr.textContent))`), 'up-right notch reads raw (76, 73), Melee (0.7125, 0.6875), as GTS did');
  check(await js(`document.querySelectorAll('#liveL .notch-dots circle').length === 8 && document.querySelector('#liveL .gate').classList.contains('measured')`), 'measured notches drawn as the gate');
  check(await js(`document.querySelector('#notchStick [data-v=l]').getAttribute('aria-pressed') === 'true' && document.querySelector('#scopeAxis [data-v=x]').getAttribute('aria-pressed') === 'true'`), 'live toggles keep their own state');
  await shot('live');
  await js(`document.querySelector('#notchStick [data-v=r]').click()`);
  check(await js(`[...document.querySelectorAll('#notchRows td')].filter(td => td.textContent === 'hold it here').length === 8`), 'c-stick notch table is separate');
  await js(`document.querySelector('#notchStick [data-v=l]').click()`);
  await js(`document.querySelector('[data-tab=controls]').click()`);
  check(await js(`document.querySelector('[data-labels=smash]').getAttribute('aria-pressed') === 'true'`), 'Smash labels by default');
  check(await js(`[...document.querySelectorAll('#rows li')].some(li => /ZR\\s*Grab/.test(li.textContent))`), 'ZR shows Grab');
  check(await js(`document.querySelector('#pad [data-name=Power]').classList.contains('fixed')`), 'Power drawn as not remappable');
  check(await js(`document.querySelector('#pad [data-name=LT]').classList.contains('fixed')`), 'analog LT drawn as not remappable');

  await js(`document.querySelector('#pad [data-name=ZR]').dispatchEvent(new MouseEvent('click', {bubbles: true}))`);
  check(await until(`!document.querySelector('#picker').hidden`), 'clicking ZR in the picture opens the picker');
  check(await js(`document.activeElement?.classList.contains('current')`), 'focus on the current job');
  await shot('picker');
  await js(`[...document.querySelectorAll('#jobs button')].find(b => b.querySelector('b').textContent === 'Jump' && /X/.test(b.textContent)).click()`);
  check(await until(`document.querySelector('#picker').hidden && document.querySelector('#pad [data-name=ZR]').classList.contains('changed')`), 'assign closes the picker and marks ZR changed');
  check(await js(`[...document.querySelectorAll('#rows li')].some(li => /ZR\\s*Jump\\s*changed/.test(li.textContent))`), 'list shows ZR -> Jump (changed)');
  check(await js(`/ZR now does Jump/.test(document.querySelector('#toast').textContent)`), 'toast confirms');
  await shot('controls-changed');
  if (shots) {
    await until(`!document.querySelector('#toast').classList.contains('show')`, 8000);
    await sleep(300);
    await shot('screenshot');
  }

  await js(`document.querySelector('[data-labels=gc]').click()`);
  check(await js(`[...document.querySelectorAll('#rows li')].some(li => /ZR\\s*X\\s*changed/.test(li.textContent))`), 'GameCube labels: ZR -> X');
  await js(`document.querySelector('[data-labels=smash]').click()`);

  await js(`document.querySelector('[data-tab=profiles]').click()`);
  await js(`document.querySelector('#profileName').value = 'Ultimate Wolf'; document.querySelector('#saveForm').requestSubmit()`);
  check(await until(`[...document.querySelectorAll('#profiles li')].some(li => /Ultimate Wolf/.test(li.textContent) && /ZR → Jump/.test(li.textContent))`), 'profile saved with ZR -> Jump');
  check(await js(`[...document.querySelectorAll('#profiles li')].find(li => /Wolf/.test(li.textContent)).querySelector('.active').hidden === false`), 'saved profile marked as on the controller');
  await js(`[...document.querySelectorAll('#profiles li')].find(li => /^Default/.test(li.textContent)).querySelector('.apply').click()`);
  check(await until(`[...document.querySelectorAll('#profiles li')].find(li => /^Default/.test(li.textContent)).querySelector('.active').hidden === false`), 'loading Default resets the layout');
  await js(`[...document.querySelectorAll('#profiles li')].find(li => /Wolf/.test(li.textContent)).querySelector('.apply').click()`);
  check(await until(`[...document.querySelectorAll('#profiles li')].find(li => /Wolf/.test(li.textContent)).querySelector('.active').hidden === false`), 'loading the Wolf profile brings ZR -> Jump back');
  await shot('profiles');

  await js(`window.confirm = () => true; document.querySelector('[data-tab=controls]').click(); document.querySelector('#resetAllBtn').click()`);
  check(await until(`!document.querySelector('#pad .changed') && document.querySelector('#resetAllBtn').disabled`), 'reset every button');

  await js(`document.querySelector('[data-tab=latency]').click(); document.querySelector('#latLive').click()`);
  check(await until(`/^\\d/.test(document.querySelector('#latAvg').textContent)`, 3000), 'live latency shows a number');
  await shot('latency');
  await js(`document.querySelector('#latLive').click()`);

  await js(`document.querySelector('[data-tab=device]').click()`);
  check(await js(`document.querySelector('.modes button.current')?.dataset.mode === 'sinput'`), 'device tab marks the current USB mode');

  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
  check(errs.length === 0, `no console errors${errs.length ? `: ${JSON.stringify(errs[0].params).slice(0, 300)}` : ''}`);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  try { ws?.close(); } catch {  }
  chrome.kill();
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
