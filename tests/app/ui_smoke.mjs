import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_PORT = 8475;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const dolphinRoot = mkdtempSync(join(tmpdir(), 'gcu-dolphin-'));
const dolphinConfig = join(dolphinRoot, 'slippi', 'Config');
mkdirSync(dolphinConfig, { recursive: true });
writeFileSync(join(dolphinConfig, 'Dolphin.ini'), '[Core]\r\nSIDevice0 = 12\r\nSIDevice1 = 6\r\n');
writeFileSync(join(dolphinConfig, 'GCPadNew.ini'), '[GCPad2]\r\nDevice = DInput/0/GCU 1\r\nButtons/A = `Button 1`\r\nButtons/X = `Button 0`\r\n');
const server = spawn(process.env.PYTHON || 'python', ['-I', join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'app', 'serve.py'),
  '--no-browser', '--port', String(APP_PORT), '--dolphin-root', dolphinRoot], { stdio: 'ignore' });
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
  await cdp('Page.navigate', { url: APP });
  check(await until(`document.readyState === 'complete' && !!document.querySelector('#adapterBtn') && document.querySelector('#adapterBtn').disabled && !document.querySelector('#adapterBrowser').hidden`), 'in a browser, the Phob section says the adapter needs the desktop app');
  check(await js(`document.querySelector('#welcomeAdapter').compareDocumentPosition(document.querySelector('.welcome-gcu')) === Node.DOCUMENT_POSITION_FOLLOWING`), 'the Phob comes first on the welcome screen');
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
  check(await js(`document.querySelector('#pad [data-name=L]').dataset.lights.split(' ').includes('LT')`), 'the L shoulder lights for the analog LT');
  check(await until(`document.querySelector('#pad .btn.lit')`), 'a pressed button lights up on the drawing');

  await js(`document.querySelector('#pad [data-name=ZR]').dispatchEvent(new MouseEvent('click', {bubbles: true}))`);
  check(await until(`!document.querySelector('#picker').hidden`), 'clicking ZR in the picture opens the picker');
  check(await js(`document.activeElement?.classList.contains('current')`), 'focus on the current job');
  await shot('picker');
  await js(`[...document.querySelectorAll('#jobs button')].find(b => b.querySelector('b').textContent === 'Jump' && /X/.test(b.textContent)).click()`);
  check(await until(`document.querySelector('#picker').hidden && document.querySelector('#pad [data-name=ZR]').classList.contains('changed')`), 'assign closes the picker and marks ZR changed');
  check(await js(`[...document.querySelectorAll('#rows li')].some(li => /ZR\\s*Jump\\s*unsaved/.test(li.textContent))`), 'list shows ZR -> Jump (unsaved)');
  check(await js(`/ZR now does Jump.*Not saved yet/.test(document.querySelector('#toast').textContent)`), 'toast says it is not saved yet');
  check(await js(`!document.querySelector('#saveBar').hidden && /1 unsaved button change\\./.test(document.querySelector('#saveBarText').textContent)`), 'save bar shows 1 unsaved change');
  check(await js(`document.querySelector('#pad [data-name=ZR]').classList.contains('unsaved')`), 'ZR drawn as unsaved');
  await shot('controls-unsaved');
  await js(`document.querySelector('#discardBtn').click()`);
  check(await until(`document.querySelector('#saveBar').hidden && [...document.querySelectorAll('#rows li')].some(li => /ZR\\s*Grab/.test(li.textContent))`), 'discard puts ZR back to Grab and hides the bar');
  await js(`document.querySelector('#pad [data-name=ZR]').dispatchEvent(new MouseEvent('click', {bubbles: true}))`);
  await until(`!document.querySelector('#picker').hidden`);
  await js(`[...document.querySelectorAll('#jobs button')].find(b => b.querySelector('b').textContent === 'Jump' && /X/.test(b.textContent)).click()`);
  await until(`!document.querySelector('#saveBar').hidden`);
  await js(`document.querySelector('#saveBtn').click()`);
  check(await until(`document.querySelector('#saveBar').hidden && [...document.querySelectorAll('#rows li')].some(li => /ZR\\s*Jump\\s*changed/.test(li.textContent))`), 'save hides the bar and ZR stays on Jump (changed)');
  check(await js(`/Saved to the controller/.test(document.querySelector('#toast').textContent)`), 'toast confirms the save');
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
  check(await js(`document.querySelector('#saveBar').hidden`), 'back on the saved layout, so nothing to save');
  await shot('profiles');

  await js(`window.confirm = () => true; document.querySelector('[data-tab=controls]').click(); document.querySelector('#resetAllBtn').click()`);
  check(await until(`!document.querySelector('#pad .changed') && document.querySelector('#resetAllBtn').disabled`), 'reset every button');

  await js(`document.querySelector('[data-tab=latency]').click(); document.querySelector('#latLive').click()`);
  check(await until(`/^\\d/.test(document.querySelector('#latAvg').textContent)`, 3000), 'live latency shows a number');
  await shot('latency');
  await js(`document.querySelector('#latLive').click()`);

  await js(`document.querySelector('[data-tab=device]').click()`);
  check(await js(`document.querySelector('.modes button.current')?.dataset.mode === 'sinput'`), 'device tab marks the current USB mode');
  check(await js(`/unsaved change/.test(document.querySelector('#devSaved').textContent)`), 'device tab counts the unsaved reset');
  await js(`document.querySelector('#saveBtn').click()`);
  check(await until(`document.querySelector('#devSaved').textContent === 'saved on the controller'`), 'device tab says saved after saving');
  check(await until(`/Port 1: GameCube Adapter for Wii U/.test(document.querySelector('#dolphin').textContent)`), 'dolphin check lists the adapter port');
  check(await js(`/reads the controller in Slippi mode/.test(document.querySelector('#dolphin').textContent)`), 'dolphin check marks the adapter port good');
  check(await js(`/A is Button 1 \\(the controller's X\\), should be Button 0/.test(document.querySelector('#dolphin').textContent)`), "dolphin check names the wrong mapping");
  const dolphinOpen = await js(`/Dolphin is open/.test(document.querySelector('#dolphin').textContent)`);
  if (dolphinOpen) {
    console.log('SKIP  fixing the mapping (Dolphin is open on this computer)');
  } else {
    await js(`window.confirm = () => true; [...document.querySelectorAll('#dolphin button')].find((b) => /Fix port 2/.test(b.textContent)).click()`);
    check(await until(`/mapping matches SInput/.test(document.querySelector('#dolphin').textContent)`), 'fixing port 2 makes its mapping match');
    check(readdirSync(dolphinConfig).some((f) => /^GCPadNew\.ini\.techchase-.*\.bak$/.test(f)), 'the fix leaves a backup');
    check(await js(`/old settings are in GCPadNew\\.ini\\.techchase-/.test(document.querySelector('#toast').textContent)`), 'the toast names the backup file');
  }
  await shot('device');
  const forged = await fetch(`${APP}api/dolphin/fix`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"install":"slippi","port":2}' });
  check(forged.status === 403, 'the server refuses a fix from another origin');

  await js(`document.querySelector('[data-tab=live]').click()`);
  const slotAngle = (side, i, which = 'analog') => js(`(async () => (await import('./calibration.js')).readSlots(window.demoDevice.${which}, '${side}')[${i}].inAngle)()`);
  const savedRight = await js(`Array.from(window.demoDevice.analog.slice(346, 682)).join(',')`);
  await js(`window.demoDevice.stick.l = { angle: 30, distance: 4 }; document.querySelector('#calibL').click()`);
  check(await until(`!document.querySelector('#calib').hidden`), 'calibrate opens the wizard');
  check(await until(`/right notch/.test(document.querySelector('#calibStep').textContent)`, 5000), 'after the center, it asks for the first notch');
  check(await js(`!document.querySelector('#saveBar').hidden && /Stick settings not saved/.test(document.querySelector('#saveBarText').textContent)`), 'the save bar shows the calibration as unsaved');
  await js(`window.demoDevice.stick.l = { angle: 120, distance: 1500 }`);
  check(await until(`/different notch/i.test(document.querySelector('#calibMsg').textContent)`, 3000), 'a hold in the wrong notch is refused');
  for (let i = 0; i < 8; i++) {
    await js(`window.demoDevice.stick.l = { angle: ${(i * 45 + 1.5 + 360) % 360}, distance: ${1500 + i} }`);
    const next = i < 7 ? `/Notch ${i + 2} of 8/.test(document.querySelector('#calibMsg').textContent)` : `!document.querySelector('#calibDone').hidden`;
    if (!(await until(next, 4000))) { check(false, `notch ${i + 1} is captured`); break; }
  }
  check(await until(`!document.querySelector('#calibDone').hidden`), 'after eight notches the wizard shows the check step');
  check(Math.abs((await slotAngle('l', 2)) - 91.5) < 0.3, 'the up notch is written at its captured angle');
  await js(`[...document.querySelectorAll('#calibRows button')][1].click()`);
  check(await until(`(async () => Math.abs((await import('./calibration.js')).readSlots(window.demoDevice.analog, 'l')[0].inAngle - 2.0) < 0.3)()`), 'turning a notch writes it half a degree on');
  await shot('calibration');
  await js(`document.querySelector('#calibDone').click(); document.querySelector('#saveBtn').click()`);
  check(await until(`document.querySelector('#saveBar').hidden`), 'saving clears the bar');
  check(Math.abs((await slotAngle('l', 2, 'savedAnalog')) - 91.5) < 0.3, 'the calibration is saved on the controller');
  check(await js(`Array.from(window.demoDevice.analog.slice(346, 682)).join(',')`) === savedRight, 'the other stick is untouched');

  const before = await js(`Array.from(window.demoDevice.analog).join(',')`);
  await js(`window.demoDevice.stick.l = { angle: 0, distance: 3 }; window.demoDevice.stick.r = { angle: 10, distance: 5 }; document.querySelector('#calibR').click()`);
  check(await until(`/right notch/.test(document.querySelector('#calibStep').textContent)`, 5000), 'the c-stick wizard starts');
  await js(`document.querySelector('#calibCancel').click()`);
  check(await until(`document.querySelector('#calib').hidden && document.querySelector('#saveBar').hidden`), 'cancel closes the wizard and the bar');
  check(await until(`Array.from(window.demoDevice.analog).join(',') === ${JSON.stringify(before)}`), 'cancel restores the settings byte for byte');

  const tuning = (side = 'l') => js(`(async () => (await import('./calibration.js')).readTuning(window.demoDevice.analog, '${side}'))()`);
  const tuneBefore = await js(`Array.from(window.demoDevice.analog).join(',')`);
  check(await js(`document.querySelector('#legalBtn').hidden`), 'the Tournament check stays hidden over USB (it reads through an adapter)');
  await js(`document.querySelector('#snapBtn').click()`);
  check(await until(`!document.querySelector('#snap').hidden && !document.querySelector('#snapGcu').hidden && document.querySelector('#snapPhob').hidden`), 'Tune snapback opens the GC Ultimate version of the panel');
  check(await until(`!document.querySelector('#snapPreHead').hidden && [...document.querySelectorAll('#snapType button')].some((b) => b.getAttribute('aria-pressed') === 'true')`), 'it shows the before-filter column and the current filter');
  await js(`document.querySelector('#snapType [data-v=lowpass]').click()`);
  check(await until(`!document.querySelector('#saveBar').hidden`), 'changing the filter raises the save bar');
  const lp = await tuning();
  check(lp.snapbackType === 0 && lp.snapbackIntensity >= 300 && lp.snapbackIntensity <= 1500, `low-pass is written to the controller (type ${lp.snapbackType}, ${lp.snapbackIntensity})`);
  check(await until(`!document.querySelector('#snapCutRow').hidden`), 'low-pass shows its cutoff slider');
  await js(`const c = document.querySelector('#snapCut'); c.value = '450'; c.dispatchEvent(new Event('change'))`);
  check(await until(`(async () => (await import('./calibration.js')).readTuning(window.demoDevice.analog, 'l').snapbackIntensity === 450)()`), 'the slider writes a 45 Hz cutoff');
  check((await tuning('r')).snapbackType === (await js(`(async () => (await import('./calibration.js')).readTuning(new Uint8Array(${JSON.stringify(tuneBefore)}.split(',').map(Number)), 'r').snapbackType)()`)), 'the c-stick filter is untouched');
  await js(`document.querySelector('#discardBtn').click()`);
  check(await until(`Array.from(window.demoDevice.analog).join(',') === ${JSON.stringify(tuneBefore)}`), 'Discard puts the filter back byte for byte');
  await js(`document.querySelector('#snapClose').click()`);

  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
  check(errs.length === 0, `no console errors${errs.length ? `: ${JSON.stringify(errs[0].params).slice(0, 300)}` : ''}`);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  try { ws?.close(); } catch {  }
  chrome.kill();
  server.kill();
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
