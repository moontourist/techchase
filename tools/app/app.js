import './tauri-usb.js';
import {
  GcuDevice, GC_CODES, SW_CODES, FORMATS, MODE_IDS, LATCH_MODES, LIVE, codeName, remappable, jobs, layoutOf, applyLayout,
  canHoldChanges,
} from './gcu-protocol.js';
import { makeDemoDevice } from './demo.js';
import { createLive } from './live.js';
import { createCalibration } from './calib-ui.js';
import { AdapterPad } from './adapter-source.js';
import { createPhobCalibration } from './phob-calib.js';
import { createSnapback } from './snapback-ui.js';
import { createTourneyCheck } from './legality-ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const GC_LABEL = {
  A: 'A', B: 'B', X: 'X', Y: 'Y', Z: 'Z', L: 'L', R: 'R', ZL: 'ZL', START: 'Start',
  UP: 'D-pad Up', DOWN: 'D-pad Down', LEFT: 'D-pad Left', RIGHT: 'D-pad Right',
  MINUS: 'Minus', HOME: 'Home', CAPTURE: 'Capture', C: 'C', LS: 'Left stick click', RS: 'C-stick click',
};
const SMASH_LABEL = {
  A: 'Attack', B: 'Special', X: 'Jump', Y: 'Jump', Z: 'Grab', L: 'Shield', R: 'Shield', START: 'Pause',
  UP: 'Up taunt', DOWN: 'Down taunt', LEFT: 'Side taunt', RIGHT: 'Side taunt',
};

const SW_LABEL = {
  UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right', PLUS: 'Plus', MINUS: 'Minus', HOME: 'Home', CAPTURE: 'Capture',
  LS: 'L-stick click', RS: 'R-stick click',
};
const swLabel = (c) => { const n = codeName(SW_CODES, c); return n ? (SW_LABEL[n] || n) : null; };
const JOB_ORDER = ['A', 'B', 'X', 'Y', 'Z', 'L', 'R', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'ZL', 'C', 'MINUS', 'HOME', 'CAPTURE', 'LS', 'RS'];
const jobRank = (gc) => { const i = JOB_ORDER.indexOf(codeName(GC_CODES, gc)); return i < 0 ? 99 : i; };

const state = {
  dev: null,
  entries: [],
  info: null,
  devInfo: null,
  labels: localStorage.getItem('gcu.labels') || 'smash',
  selected: null,
  busy: false,
  live: null,
  unsubLive: null,
  savedJobs: null,
  unsaved: false,
  stayDisconnected: false,
  pad: null,
  unsubPadData: null,
};
const liveView = createLive({ root: $('#tab-live'), entries: () => state.entries });
const calib = createCalibration({ root: $('#tab-live'), getDev: () => state.dev, onChange: () => renderSaveBar(), toast });

const snap = createSnapback({
  root: $('#tab-live'),
  toast,
  gcu: {
    canWrite: () => !!state.dev && holdsChanges(),
    tuning: (s) => calib.tuning(s),
    setTuning: (s, p) => calib.setTuning(s, p),
  },
});
const tourney = createTourneyCheck({ root: $('#tab-live'), toast });

const PAD_SETTLED = 12;
const phob = createPhobCalibration({
  root: $('#tab-live'),
  onDone: () => setTimeout(() => {
    const p = state.pad?.last?.[state.pad.port];
    const o = state.pad?.origin;
    if (!p || !o) return;
    const near = [p.main.x - o.lx, p.main.y - o.ly, p.c.x - o.rx, p.c.y - o.ry].every((d) => Math.abs(d) <= PAD_SETTLED);
    if (near) state.pad.recenter();
  }, 1000),
});

function renderCalibButtons() {
  $('#snapBtn').disabled = !state.dev && !state.pad;
  $('#legalBtn').hidden = !state.pad;
  if (state.pad) {
    for (const id of ['#calibL', '#calibR']) { $(id).disabled = false; $(id).title = ''; }
    $('#calibReset').hidden = true;
    $('#calibHint').textContent = '';
    return;
  }
  $('#calibReset').hidden = false;
  const ok = !!state.dev && holdsChanges();
  for (const id of ['#calibL', '#calibR', '#calibReset']) {
    $(id).disabled = !ok;
    $(id).title = ok ? '' : 'Needs the techchase firmware (protocol 2), which can hold a calibration until you save it.';
  }
}
$('#calibReset').addEventListener('click', () => {
  if (calib.step !== 'idle') return;
  if (!confirm('Reset both sticks to the factory settings? Notches, deadzones and snapback go back to how the controller shipped, and the centers are measured again (let go of the sticks). It works at once; nothing is saved until you press Save to controller.')) return;
  calib.reset();
});
$('#snapBtn').addEventListener('click', () => {
  if (!state.dev && !state.pad) return;
  tourney.stop();
  snap.start(state.pad ? 'phob' : 'gcu');
});
$('#legalBtn').addEventListener('click', () => {
  if (!state.pad) return;
  snap.stop();
  phob.stop();
  tourney.start();
});
for (const [id, side] of [['#calibL', 'l'], ['#calibR', 'r']]) {
  $(id).addEventListener('click', () => {
    if (state.pad) { tourney.stop(); phob.start(side === 'l' ? 'main' : 'c'); return; }
    if (calib.step !== 'idle') return;
    calib.start(side);
  });
}

function jobLabel(gcCode, { both = false } = {}) {
  const gc = codeName(GC_CODES, gcCode);
  if (!gc) return 'Nothing';
  const g = GC_LABEL[gc] || gc;
  const s = SMASH_LABEL[gc];
  if (state.labels === 'smash') return s ? (both ? `${s} (${g})` : s) : g;
  return both && s ? `${g} · ${s}` : g;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, kind === 'error' ? 6000 : 3200);
}

async function guard(fn, what) {
  if (state.busy) return;
  state.busy = true;
  document.body.style.cursor = 'progress';
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(`${what}: ${e.message || e}`, 'error');
  } finally {
    state.busy = false;
    document.body.style.cursor = '';
  }
}

const FILTERS = [{ vendorId: 0x057E, classCode: 0xFF }, { vendorId: 0x2E8A, classCode: 0xFF }];

let padReport = null;
let padFrame = 0;
function lightPad(rep) {
  padReport = rep;
  if (padFrame) return;
  padFrame = requestAnimationFrame(() => {
    padFrame = 0;
    const down = new Set(state.entries.filter((e) => padReport?.presses?.has(e.code)).map((e) => e.name));
    for (const g of $$('#pad .btn')) {
      const names = (g.dataset.lights || g.dataset.name).split(' ');
      g.classList.toggle('lit', names.some((n) => down.has(n)));
    }
  });
}

async function attach(dev) {
  await dev.open();
  state.dev = dev;
  state.devInfo = await dev.deviceInfo();
  state.info = await dev.info();
  liveView.reset();
  state.unsubLive = dev.onLive((rep) => { liveView.push(rep); snap.feedGcu(rep); });
  state.unsubPad = dev.onLive(lightPad);
  await dev.setLiveMode(LIVE.TECHCHASE);
  state.unsaved = !!state.info.unsaved;
  state.savedJobs = null;
  await refreshMap();
  if (!state.unsaved) markSaved();
  renderConnection();
  renderDevice();
  renderCalibButtons();
  if (holdsChanges()) calib.refreshHint();
  showTab(currentTab());
  if (!state.info.techchase) toast('Connected. This controller runs official firmware: remapping and latency need the techchase firmware.', 'error');
}

const ADAPTER_FIRST_REPORT_MS = 600;

function renderPadLine() {
  const pad = state.pad;
  $('#padLine').hidden = !pad;
  if (!pad) return;
  const ports = pad.connectedPorts();
  $('#padWhere').textContent = ports.includes(pad.port)
    ? `${pad.name} · port ${pad.port + 1}`
    : `${pad.name} · no controller in port ${pad.port + 1}. Plug one in.`;
  $('#padPorts').replaceChildren(...(ports.length > 1 ? ports.map((i) => {
    const b = document.createElement('button');
    b.className = `ghost small-btn${i === pad.port ? ' on' : ''}`;
    b.textContent = `port ${i + 1}`;
    b.addEventListener('click', () => { pad.usePort(i); liveView.reset(); renderPadLine(); renderConnection(); });
    return b;
  }) : []));
}

async function attachPad() {
  const pad = new AdapterPad();
  await pad.open();
  await new Promise((r) => setTimeout(r, ADAPTER_FIRST_REPORT_MS));
  const ports = pad.connectedPorts();
  pad.usePort(ports.length ? ports[0] : 0);
  state.pad = pad;
  liveView.reset();
  liveView.setGate('phob');
  state.unsubPadData = pad.onReading((p, rep) => { liveView.push(rep); phob.feed(p, rep); snap.feedPad(p, rep); tourney.feedPad(p); });
  pad.onPorts(() => { renderPadLine(); renderConnection(); });
  renderConnection();
  renderPadLine();
  renderCalibButtons();
  showTab('live');
  if (!ports.length) toast('The adapter is open, but no controller is plugged into it.', 'error');
}

async function detachPad(msg) {
  const pad = state.pad;
  if (!pad) return;
  state.pad = null;
  state.unsubPadData?.();
  state.unsubPadData = null;
  phob.stop();
  snap.stop();
  tourney.stop();
  liveView.stop();
  liveView.reset();
  liveView.setGate('gcu');
  try { await pad.close(); } catch { }
  renderPadLine();
  renderConnection();
  renderCalibButtons();
  showTab(currentTab());
  if (msg) toast(msg);
}

async function connectAdapter() {
  state.stayDisconnected = false;
  await guard(() => attachPad(), 'Could not open the adapter');
}

async function connect() {
  if (!navigator.usb) return;
  let usbDev;
  try {
    usbDev = await navigator.usb.requestDevice({ filters: FILTERS });
  } catch (e) {
    if (window.__TAURI__) {
      try {
        await attachPad();
      } catch (adapterError) {
        toast(`No GC Ultimate found, and no GameCube adapter could be opened (${adapterError.message || adapterError}).`, 'error');
      }
    }
    return;
  }
  await guard(() => attach(new GcuDevice(usbDev)), 'Could not connect');
}

async function autoConnect() {
  if (!navigator.usb) return;
  for (const d of await navigator.usb.getDevices()) {
    if (d.vendorId !== 0x057E && d.vendorId !== 0x2E8A) continue;
    try {
      await attach(new GcuDevice(d));
      return;
    } catch (e) {
      console.warn('auto-connect skipped', e);
    }
  }
}

function detach(msg) {
  stopLive();
  state.unsubLive?.();
  state.unsubLive = null;
  state.unsubPad?.();
  state.unsubPad = null;
  lightPad(null);
  liveView.stop();
  liveView.reset();
  calib.detach();
  snap.stop();
  state.dev = null;
  state.entries = [];
  state.selected = null;
  state.unsaved = false;
  state.savedJobs = null;
  renderSaveBar();
  renderConnection();
  showTab(currentTab());
  if (msg) toast(msg);
}

if (navigator.usb) {
  navigator.usb.addEventListener('disconnect', (ev) => {
    if (state.dev && state.dev.dev === ev.device) detach('Controller unplugged (or restarting its USB).');
  });
  navigator.usb.addEventListener('connect', (ev) => {
    if (!state.dev && !state.stayDisconnected) setTimeout(() => guard(() => attach(new GcuDevice(ev.device)), 'Could not reconnect'), 300);
  });
}

function renderConnection() {
  const s = $('#connStatus');
  const btn = $('#connectBtn');
  for (const b of $$('.tabs button')) {
    b.hidden = !!state.pad && b.dataset.tab !== 'live';
  }
  if (state.pad) {
    const ports = state.pad.connectedPorts();
    s.textContent = ports.includes(state.pad.port) ? `Adapter port ${state.pad.port + 1}` : 'Adapter, no controller';
    s.className = `status ${ports.includes(state.pad.port) ? 'on' : 'demo'}`;
    btn.textContent = 'Disconnect';
    $('#welcome').hidden = true;
    return;
  }
  if (state.dev) {
    s.textContent = state.dev.demo ? 'Demo controller' : `${state.dev.productName} · ${FORMATS[state.info?.reportFormat] ?? 'connected'}`;
    s.className = `status ${state.dev.demo ? 'demo' : 'on'}`;
    btn.textContent = 'Disconnect';
  } else {
    s.textContent = 'Not connected';
    s.className = 'status off';
    btn.textContent = 'Connect controller';
  }
  $('#welcome').hidden = !!state.dev;
}

$('#connectBtn').addEventListener('click', async () => {
  if (state.pad) {
    state.stayDisconnected = true;
    await detachPad();
    return;
  }
  if (state.dev) {
    if (hasUnsaved() && !confirm('You have unsaved changes. The controller keeps them until it’s unplugged, then goes back to its saved layout. Disconnect anyway?')) return;
    const d = state.dev;
    state.stayDisconnected = true;
    detach();
    await d.close();
  } else {
    state.stayDisconnected = false;
    await connect();
  }
});

function currentTab() { return $('.tabs [aria-selected="true"]').dataset.tab; }
function showTab(name) {
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const s of $$('.tab')) s.hidden = !(state.dev || state.pad) || s.id !== `tab-${name}`;
  if (name !== 'latency') stopLive();
  if (name === 'profiles') renderProfiles();
  if (name === 'controls' && state.dev) renderControls();
  if (name === 'live' && (state.dev || state.pad)) liveView.start(); else liveView.stop();
  if (name === 'device' && state.dev) renderDolphin();
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function dolphinPortLine(inst, p) {
  const li = el('li');
  li.append(el('b', `Port ${p.port}: `), p.name);
  const prof = p.profile;
  if (p.si === 12) {
    li.append(el('span', ' · reads the controller in Slippi mode', 'good'));
  } else if (prof?.reads === 'gcu' && !prof.checkable) {
    li.append(el('span', ` · reads ${prof.device} through ${prof.backend}; only DirectInput mappings are checked`, 'muted'));
  } else if (prof?.reads === 'gcu' && prof.wrong.length === 0) {
    li.append(el('span', ` · reads ${prof.device}, mapping matches SInput`, 'good'));
  } else if (prof?.reads === 'gcu') {
    li.append(el('span', ` · reads ${prof.device}: ${prof.wrong.length} input${prof.wrong.length === 1 ? '' : 's'} mapped wrong`, 'bad'));
    const list = el('div', null, 'wrong');
    for (const w of prof.wrong.slice(0, 8)) {
      list.append(el('div', `${w.input} is ${w.has}${w.gets ? ` (the controller's ${w.gets})` : ''}, should be ${w.want}`));
    }
    if (prof.wrong.length > 8) list.append(el('div', `and ${prof.wrong.length - 8} more`));
    li.append(list);
    const fix = el('button', `Fix port ${p.port}'s mapping`, 'ghost');
    fix.addEventListener('click', () => fixDolphin(inst, p));
    li.append(fix);
  } else if (prof) {
    li.append(el('span', ` · reads ${prof.device || 'nothing'}`, 'muted'));
  }
  return li;
}

async function renderDolphin() {
  const box = $('#dolphin');
  let r;
  try {
    if (window.__TAURI__) {
      r = await window.__TAURI__.core.invoke('dolphin_check');
    } else {
      const res = await fetch('api/dolphin', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      r = await res.json();
    }
  } catch {
    box.replaceChildren(el('p', 'The Dolphin check needs the app started from tools/app/serve.py on this computer.', 'muted'));
    $('#dolphinRefresh').hidden = true;
    return;
  }
  $('#dolphinRefresh').hidden = false;
  const parts = [];
  if (!r.installs.length) parts.push(el('p', 'No Dolphin settings found on this computer.', 'muted'));
  if (r.dolphin_running) parts.push(el('p', 'Dolphin is open. Close it before fixing a mapping: it rewrites its settings when it closes.', 'warn'));
  for (const inst of r.installs) {
    const card = el('div', null, 'install');
    card.append(el('b', inst.label), el('div', inst.path, 'path'));
    const ul = el('ul');
    for (const p of inst.ports) ul.append(dolphinPortLine(inst, p));
    card.append(ul);
    parts.push(card);
  }
  box.replaceChildren(...parts);
}

async function fixDolphin(inst, p) {
  if (!confirm(`Rewrite port ${p.port}'s buttons, sticks and triggers in ${inst.label} to match the controller in SInput mode? The old file is backed up next to it first.`)) return;
  await guard(async () => {
    let out;
    if (window.__TAURI__) {
      out = await window.__TAURI__.core.invoke('dolphin_fix', { install: inst.id, port: p.port });
    } else {
      const res = await fetch('api/dolphin/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Techchase': '1' },
        body: JSON.stringify({ install: inst.id, port: p.port }),
      });
      out = await res.json();
      if (!res.ok) throw new Error(out.error || res.status);
    }
    toast(`Port ${p.port} fixed. The old settings are in ${out.backup.split(/[\\/]/).pop()}.`, 'ok');
    await renderDolphin();
  }, 'Dolphin fix failed');
}
$('#dolphinRefresh').addEventListener('click', () => renderDolphin());
for (const b of $$('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

async function refreshMap() {
  state.entries = await state.dev.map();
  renderControls();
}

function entryByCode(code) { return state.entries.find((e) => e.code === code); }

const holdsChanges = () => canHoldChanges(state.info);
const isUnsaved = (e) => !!state.savedJobs && state.savedJobs.get(e.code) !== e.gcCur;

function markSaved() {
  state.savedJobs = new Map(state.entries.map((e) => [e.code, e.gcCur]));
  state.unsaved = false;
  renderSaveBar();
}

function unsavedCount() {
  return state.savedJobs ? remappable(state.entries).filter(isUnsaved).length : null;
}

function remapsUnsaved() {
  if (!state.dev || !holdsChanges() || !state.unsaved) return false;
  const n = unsavedCount();
  return n === null || n > 0;
}

function hasUnsaved() {
  return remapsUnsaved() || (!!state.dev && calib.pending);
}

function renderSavedState() {
  const n = unsavedCount();
  let text = 'saved on the controller';
  if (!holdsChanges()) text = 'saved with every change (older techchase firmware)';
  else if (remapsUnsaved()) text = n === null ? 'unsaved changes' : `${n} unsaved change${n === 1 ? '' : 's'}`;
  $('#devSaved').textContent = text;
}

function renderSaveBar() {
  $('#saveBar').hidden = !hasUnsaved();
  const n = unsavedCount();
  const parts = [];
  if (remapsUnsaved()) parts.push(n === null ? 'Unsaved button changes.' : `${n} unsaved button change${n === 1 ? '' : 's'}.`);
  if (state.dev && calib.pending) parts.push('Stick settings not saved.');
  $('#saveBarText').textContent = `${parts.join(' ')} Changes work now: try them on the Live tab, then save.`;
  if (state.dev) renderSavedState();
}

async function keepChanges() {
  await guard(async () => {
    await state.dev.save();
    markSaved();
    calib.saved();
    snap.refresh();
    renderControls();
    if (currentTab() === 'profiles') renderProfiles();
    toast('Saved to the controller.', 'ok');
  }, 'Saving failed');
}

async function dropChanges() {
  await guard(async () => {
    if (calib.step !== 'idle') await calib.cancel();
    else if (calib.pending) await calib.discard();
    snap.reload();
    if (remapsUnsaved()) {
      await state.dev.revert();
      await refreshMap();
    }
    markSaved();
    renderControls();
    if (currentTab() === 'profiles') renderProfiles();
    toast('Changes discarded. The controller is back to its saved settings.', 'ok');
  }, 'Discarding failed');
}

$('#saveBtn').addEventListener('click', keepChanges);
$('#discardBtn').addEventListener('click', dropChanges);
window.addEventListener('beforeunload', (ev) => {
  if (!hasUnsaved()) return;
  ev.preventDefault();
  ev.returnValue = '';
});

function renderControls() {
  const editable = new Map(remappable(state.entries).map((e) => [e.name, e]));
  const byName = new Map(state.entries.map((e) => [e.name, e]));

  for (const g of $$('#pad .btn')) {
    const name = g.dataset.name;
    const e = editable.get(name);
    const known = byName.get(name);
    g.classList.toggle('editable', !!e);
    g.classList.toggle('fixed', !e);
    g.classList.toggle('changed', !!e && e.gcCur !== e.gcDef);
    g.classList.toggle('unsaved', !!e && isUnsaved(e));
    g.classList.toggle('selected', !!e && e.code === state.selected);
    g.setAttribute('tabindex', e ? '0' : '-1');
    g.setAttribute('role', e ? 'button' : 'img');
    g.setAttribute('aria-label', e ? `${name}: ${jobLabel(e.gcCur)}` : `${name}${known ? '' : ' (not on this controller)'}`);
  }

  const layer = $('#padTags');
  layer.textContent = '';
  for (const e of editable.values()) {
    if (e.gcCur === e.gcDef) continue;
    const g = $(`#pad .btn[data-name="${CSS.escape(e.name)}"]`);
    if (!g) continue;
    const box = g.getBBox();
    const up = box.y < 50;
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('class', 'job');
    t.setAttribute('x', box.x + box.width / 2);
    t.setAttribute('y', up ? box.y - 6 : box.y + box.height + 13);
    t.textContent = `→ ${jobLabel(e.gcCur)}`;
    layer.appendChild(t);
  }

  const rows = $('#rows');
  rows.textContent = '';
  for (const e of remappable(state.entries)) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    const changed = e.gcCur !== e.gcDef;
    let tag = '<span></span>';
    if (isUnsaved(e)) tag = '<span class="tag unsaved">unsaved</span>';
    else if (changed) tag = '<span class="tag">changed</span>';
    b.innerHTML = `<span class="name"></span><span class="job"></span>${tag}`;
    b.querySelector('.name').textContent = e.name;
    b.querySelector('.job').textContent = jobLabel(e.gcCur);
    b.addEventListener('click', () => select(e.code));
    li.appendChild(b);
    rows.appendChild(li);
  }
  $('#resetAllBtn').disabled = !layoutOf(state.entries).length;

  renderPicker();
  renderSaveBar();
}

function select(code) {
  state.selected = code;
  renderControls();
  if (code != null) ($('#jobs button.current') || $('#jobs button'))?.focus();
}

function renderPicker() {
  const e = state.selected != null ? entryByCode(state.selected) : null;
  $('#picker').hidden = !e;
  $('#pickerEmpty').hidden = !!e;
  if (!e) return;
  $('#pickerName').textContent = e.name;
  const sw = swLabel(e.swCur);
  $('#pickerNow').textContent = `Now: ${jobLabel(e.gcCur, { both: true })} on GameCube/Slippi${sw ? `, ${sw} on Switch` : ''}.`;
  const box = $('#jobs');
  box.textContent = '';
  for (const j of jobs(state.entries).sort((a, b) => jobRank(a.gc) - jobRank(b.gc))) {
    const b = document.createElement('button');
    const own = j.target === e.code;
    b.className = `${j.gc === e.gcCur ? 'current' : ''} ${own ? 'own' : ''}`;
    const gcName = codeName(GC_CODES, j.gc);
    const other = state.labels === 'smash' ? (SMASH_LABEL[gcName] ? GC_LABEL[gcName] : null) : SMASH_LABEL[gcName];
    const swName = swLabel(j.sw);
    b.innerHTML = '<b></b><span></span>';
    b.querySelector('b').textContent = jobLabel(j.gc);
    b.querySelector('span').textContent = [other, swName && `Switch: ${swName}`].filter(Boolean).join(' · ');
    b.addEventListener('click', () => assign(e, j));
    box.appendChild(b);
  }
}

async function assign(e, job) {
  await guard(async () => {
    const save = !holdsChanges();
    const ok = await state.dev.assign(e.code, job.target, { save });
    if (!ok) throw new Error('the controller refused');
    if (!save) state.unsaved = true;
    await refreshMap();
    const done = job.target === e.code ? `${e.name} is back to its default.` : `${e.name} now does ${jobLabel(job.gc, { both: true })}.`;
    toast(`${done} ${save ? 'Saved.' : 'Not saved yet.'}`, 'ok');
    state.selected = null;
    renderControls();
  }, 'Remap failed');
}

for (const g of $$('#pad .btn')) {
  const pick = () => {
    const e = remappable(state.entries).find((x) => x.name === g.dataset.name);
    if (e) select(e.code);
  };
  g.addEventListener('click', pick);
  g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
}
$('#pickerBack').addEventListener('click', () => select(null));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && state.selected != null) select(null); });
$('#resetAllBtn').addEventListener('click', () => guard(async () => {
  if (!confirm('Put every button back to its default job?')) return;
  const save = !holdsChanges();
  await state.dev.resetAll({ save });
  if (!save) state.unsaved = true;
  await refreshMap();
  toast(`Every button is back to default. ${save ? 'Saved.' : 'Not saved yet.'}`, 'ok');
}, 'Reset failed'));

for (const b of $$('#labelSeg button')) {
  b.addEventListener('click', () => {
    state.labels = b.dataset.labels;
    localStorage.setItem('gcu.labels', state.labels);
    for (const x of $$('#labelSeg button')) x.setAttribute('aria-pressed', String(x === b));
    renderControls();
  });
  b.setAttribute('aria-pressed', String(b.dataset.labels === state.labels));
}

const loadProfiles = () => JSON.parse(localStorage.getItem('gcu.profiles') || '[]');
const saveProfiles = (p) => localStorage.setItem('gcu.profiles', JSON.stringify(p));

function namedLayout() {
  return layoutOf(state.entries).map(([s, t]) => [entryByCode(s).name, entryByCode(t).name]);
}
function describe(pairs) {
  if (!pairs.length) return 'Every button on its default job.';
  return pairs.map(([s, t]) => {
    const te = state.entries.find((e) => e.name === t);
    return `${s} → ${te ? jobLabel(te.gcDef) : t}`;
  }).join(', ');
}
function sameLayout(a, b) {
  const k = (p) => JSON.stringify(p.map((x) => x.join('>')).sort());
  return k(a) === k(b);
}

function renderProfiles() {
  const list = $('#profiles');
  list.textContent = '';
  const now = state.dev ? namedLayout() : [];
  const profiles = [{ name: 'Default', pairs: [], builtin: true }, ...loadProfiles()];
  for (const [i, p] of profiles.entries()) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="pname"></span><span class="pdesc"></span><span class="active" hidden>● on the controller</span>' +
      `<button class="${p.builtin ? 'ghost' : 'primary'} apply">Load</button>` + (p.builtin ? '' : '<button class="ghost dl">Export</button><button class="ghost danger del">Delete</button>');
    li.querySelector('.pname').textContent = p.name;
    li.querySelector('.pdesc').textContent = describe(p.pairs);
    li.querySelector('.active').hidden = !sameLayout(now, p.pairs);
    li.querySelector('.apply').addEventListener('click', () => loadProfile(p));
    li.querySelector('.dl')?.addEventListener('click', () => download(`gcu-profile-${p.name.replace(/[^\w-]+/g, '_')}.json`, { gcuProfiles: 1, profiles: [p] }));
    li.querySelector('.del')?.addEventListener('click', () => {
      if (!confirm(`Delete “${p.name}”?`)) return;
      const all = loadProfiles();
      all.splice(i - 1, 1);
      saveProfiles(all);
      renderProfiles();
    });
    list.appendChild(li);
  }
}

async function loadProfile(p) {
  await guard(async () => {
    const byName = new Map(state.entries.map((e) => [e.name, e.code]));
    const pairs = [];
    for (const [s, t] of p.pairs) {
      if (!byName.has(s) || !byName.has(t)) throw new Error(`this controller has no “${byName.has(s) ? t : s}” button`);
      pairs.push([byName.get(s), byName.get(t)]);
    }
    const save = !holdsChanges();
    await applyLayout(state.dev, pairs, { save });
    if (!save) state.unsaved = true;
    await refreshMap();
    renderProfiles();
    toast(`Loaded “${p.name}”. ${save ? 'Saved on the controller.' : 'Not saved yet.'}`, 'ok');
  }, 'Loading the profile failed');
}

$('#saveForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const name = $('#profileName').value.trim();
  if (!name) return;
  const all = loadProfiles();
  const at = all.findIndex((p) => p.name === name);
  const p = { name, pairs: namedLayout(), board: state.devInfo?.name, saved: new Date().toISOString() };
  if (at >= 0) {
    if (!confirm(`Replace the profile “${name}”?`)) return;
    all[at] = p;
  } else {
    all.push(p);
  }
  saveProfiles(all);
  $('#profileName').value = '';
  renderProfiles();
  toast(`Saved “${name}”.`, 'ok');
});

$('#exportBtn').addEventListener('click', () => download('gcu-profiles.json', { gcuProfiles: 1, profiles: loadProfiles() }));
$('#importFile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!data.gcuProfiles || !Array.isArray(data.profiles)) throw new Error('not a GCU profiles file');
    const all = loadProfiles();
    let n = 0;
    for (const p of data.profiles) {
      if (typeof p.name !== 'string' || !Array.isArray(p.pairs)) continue;
      const clean = { name: p.name.slice(0, 40), pairs: p.pairs.filter((x) => Array.isArray(x) && x.length === 2).map(([a, b]) => [String(a), String(b)]) };
      const at = all.findIndex((q) => q.name === clean.name);
      if (at >= 0) all[at] = clean; else all.push(clean);
      n++;
    }
    saveProfiles(all);
    renderProfiles();
    toast(`Imported ${n} profile${n === 1 ? '' : 's'}.`, 'ok');
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'error');
  }
});

function download(name, obj) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (n == null ? '--' : Math.round(n).toLocaleString());

function showStats(s, secs) {
  if (!s.count) {
    $('#latAvg').textContent = '--';
    $('#latSub').textContent = 'Nothing is reading the controller right now. Start a game or emulator.';
    for (const id of ['#latMinMax', '#latRate', '#latMiss']) $(id).textContent = '--';
  } else {
    $('#latAvg').textContent = fmt(s.ageAvgUs);
    $('#latSub').textContent = s.latchOff ? 'Stock HHL timing (late-latch is off).' : (s.mode === 2 ? 'Late-latch is timing each read to the host’s poll.' : 'The host isn’t polling every millisecond, so stock timing is used.');
    $('#latMinMax').textContent = `${fmt(s.ageMinUs)} / ${fmt(s.ageMaxUs)} µs`;
    $('#latRate').textContent = fmt(s.count / secs);
    $('#latMiss').textContent = fmt(s.misses);
  }
  $('#latMode').textContent = s.latchOff ? 'Stock (late-latch off)' : (LATCH_MODES[s.mode] || '--');
}

function stopLive() {
  if (state.live) state.live.stop = true;
  state.live = null;
  $('#latLive').textContent = 'Start';
}

async function live() {
  if (state.live) { stopLive(); return; }
  const run = { stop: false };
  state.live = run;
  $('#latLive').textContent = 'Stop';
  try {
    while (!run.stop && state.dev) {
      await state.dev.resetStats();
      const t = performance.now();
      await sleep(1000);
      if (run.stop || !state.dev) break;
      const s = await state.dev.stats();
      showStats(s, (performance.now() - t) / 1000);
    }
  } catch (e) {
    toast(`Latency: ${e.message}`, 'error');
    stopLive();
  }
}
$('#latLive').addEventListener('click', live);

$('#latchToggle').addEventListener('change', (ev) => guard(async () => {
  await state.dev.setLatch(ev.target.checked);
  state.info = await state.dev.info();
  toast(ev.target.checked ? 'Late-latch on.' : 'Late-latch off: stock HHL timing until you turn it back on or unplug.');
}, 'Could not switch late-latch'));

$('#abBtn').addEventListener('click', () => guard(async () => {
  stopLive();
  const table = $('#abTable');
  const body = table.querySelector('tbody');
  body.textContent = '';
  table.hidden = false;
  $('#abSummary').textContent = 'Running… keep the game or emulator open.';
  const res = { 0: [], 1: [] };
  let round = 0;
  for (const on of [0, 1, 0, 1]) {
    round++;
    await state.dev.setLatch(!!on);
    await sleep(600);
    await state.dev.resetStats();
    const t = performance.now();
    await sleep(4400);
    const s = await state.dev.stats();
    const secs = (performance.now() - t) / 1000;
    if (s.count) res[on].push(s.ageAvgUs);
    const tr = document.createElement('tr');
    for (const v of [round, on ? 'Late-latch' : 'Stock', `${fmt(s.ageAvgUs)} µs`, `${fmt(s.ageMinUs)} µs`, `${fmt(s.ageMaxUs)} µs`, fmt(s.misses), fmt(s.count / secs)]) {
      const td = document.createElement('td');
      td.textContent = s.count || typeof v === 'number' || v === 'Late-latch' || v === 'Stock' ? v : '--';
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  await state.dev.setLatch(true);
  $('#latchToggle').checked = true;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  $('#abSummary').textContent = res[0].length && res[1].length
    ? `Input age ${fmt(avg(res[0]))} µs → ${fmt(avg(res[1]))} µs: ${fmt(avg(res[0]) - avg(res[1]))} µs less with late-latch.`
    : 'No reports were measured. Is something reading the controller?';
}, 'A/B test failed'));

function renderDevice() {
  if (!state.dev) return;
  const di = state.devInfo || {};
  $('#devName').textContent = `${state.dev.productName} (${state.dev.vendorId.toString(16).padStart(4, '0')}:${state.dev.productId.toString(16).padStart(4, '0')}), board ${di.name ?? '?'}`;
  $('#devFw').textContent = di.fwVersion ? `${di.fwVersion}, built ${new Date(di.fwVersion * 1000).toLocaleString()}` : '--';
  $('#devMode').textContent = FORMATS[state.info?.reportFormat] ?? '--';
  $('#devTechchase').textContent = state.info?.techchase ? `yes (protocol ${state.info.proto}), late-latch ${state.info.latchOn ? 'on' : 'off'}` : 'no, official firmware';
  $('#latchToggle').checked = !!state.info?.latchOn;
  renderSavedState();
  for (const b of $$('.modes button')) b.classList.toggle('current', MODE_IDS[b.dataset.mode] === state.info?.reportFormat);
}

for (const b of $$('.modes button')) {
  b.addEventListener('click', () => guard(async () => {
    const id = MODE_IDS[b.dataset.mode];
    if (id === state.info?.reportFormat) return;
    if (hasUnsaved() && !state.dev.demo && !confirm('Switching USB mode restarts the controller, which drops unsaved changes. Switch anyway?')) return;
    if (id === MODE_IDS.slippi && !state.dev.demo && !confirm('In Slippi mode the controller is a plain GameCube adapter, so this app disconnects until you unplug it. Switch?')) return;
    const ok = await state.dev.setUsbMode(id);
    if (!ok) throw new Error('the controller refused (is it on USB?)');
    if (state.dev.demo) {
      state.info = await state.dev.info();
      renderDevice();
      renderConnection();
      toast(`Switched to ${FORMATS[id]} (demo).`, 'ok');
    } else if (id === MODE_IDS.slippi) {
      state.stayDisconnected = true;
      toast('Switched to Slippi. Unplug the controller to use the app again.', 'ok');
    } else {
      toast(`Switching to ${FORMATS[id]}… If the controller doesn’t come back by itself, press Connect controller.`);
    }
  }, 'Mode switch failed'));
}

$('#backupBtn').addEventListener('click', () => guard(async () => {
  const b = await state.dev.backup();
  download(`gcu-backup-${b.fw_version}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`, b);
  toast('Backup downloaded.', 'ok');
}, 'Backup failed'));

renderConnection();
const params = new URLSearchParams(location.search);
if (params.has('demo')) {
  guard(async () => attach(await makeDemoDevice()), 'Demo failed').then(() => {
    const tab = params.get('tab');
    if (tab) showTab(tab);
    const sel = params.get('select');
    if (sel) { const e = state.entries.find((x) => x.name === sel); if (e) select(e.code); }
  });
} else if (!navigator.usb) {
  $('#noWebUsb').hidden = false;
  $('#connectBtn').disabled = true;
} else {
  autoConnect();
}

if (!window.__TAURI__) {
  $('#adapterBtn').disabled = true;
  $('#adapterBrowser').hidden = false;
} else {
  $('#adapterBtn').addEventListener('click', connectAdapter);
  $('#padZero').addEventListener('click', () => { state.pad?.recenter(); toast('Centers taken from where the sticks rest now.', 'ok'); });
  window.__TAURI__.event.listen('adapter-lost', () => detachPad('The adapter was unplugged (or Dolphin took it over).'));
}
