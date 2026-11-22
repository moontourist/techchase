import {
  DIRECTIONS, GCU_CUTOFF, GCU_TYPES, createPhobSettingsReader, createSnapbackMeter, gcuAdvice, gcuType, hz, melee, phobAdvice, verdict,
} from './snapback.js';
import { gcAxis } from './melee.js';

const VERDICT_TEXT = { ok: 'ok', close: 'close', crosses: 'past the deadzone', none: '' };
const TYPE_TEXT = { auto: 'Auto', lowpass: 'Low-pass', off: 'Off' };

const toGc = (rep, v) => (rep.gc ? Math.max(-128, Math.min(127, v)) : gcAxis(v));

export function createSnapback({ root, toast, gcu }) {
  const $ = (s) => root.querySelector(s);
  const panel = $('#snap');
  const meter = createSnapbackMeter();
  let reader = createPhobSettingsReader();
  let mode = null;
  let side = 'l';
  let phobSettings = null;
  let tuning = null;
  let frame = 0;
  let seen = -1;
  let busy = false;

  function cell(text, cls = '') {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  function renderRows() {
    const showPre = mode === 'gcu';
    $('#snapPreHead').hidden = !showPre;
    $('#snapRows').replaceChildren(...DIRECTIONS.map((d) => {
      const tr = document.createElement('tr');
      const worst = meter.worst(d.key);
      const v = verdict(worst);
      tr.append(cell(d.name), cell(String(meter.results(d.key).length)), cell(worst === null ? '--' : melee(worst)));
      if (showPre) {
        const p = meter.worstPre(d.key);
        tr.append(cell(p === null ? '--' : melee(p), 'muted'));
      }
      tr.append(cell(VERDICT_TEXT[v], `verdict ${v}`));
      return tr;
    }));
  }

  function renderSettings() {
    if (mode === 'phob') {
      const s = phobSettings;
      $('#snapPhobSettings').textContent = s
        ? `Snapback: left/right ${s.snapback.x}, up/down ${s.snapback.y} (standard is 4).${s.smoothing ? ` Smoothing ${s.smoothing.x}/${s.smoothing.y}, waveshaping ${s.waveshaping.x}/${s.waveshaping.y}.` : ''}`
        : 'Not read yet.';
      $('#snapPhobSettings').className = s ? 'ok-text' : 'muted';
      return;
    }
    const t = tuning;
    for (const b of $('#snapType').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(!!t && gcuType(t.snapbackType) === b.dataset.v));
      b.disabled = !t || busy || !gcu.canWrite();
    }
    const lowpass = t && gcuType(t.snapbackType) === 'lowpass';
    $('#snapCutRow').hidden = !lowpass;
    if (t) {
      const c = Math.max(GCU_CUTOFF.min, Math.min(GCU_CUTOFF.max, t.snapbackIntensity));
      $('#snapCut').value = String(c);
      $('#snapCutVal').textContent = hz(c);
      $('#snapCut').disabled = busy || !gcu.canWrite();
    }
    $('#snapGcuNote').textContent = !gcu.canWrite()
      ? 'Changing the filter needs the techchase firmware (protocol 2).'
      : t && gcuType(t.snapbackType) === 'auto'
        ? `Auto ${t.springTuned ? 'uses the spring model fitted to this stick' : 'adapts to the stick on its own'}. Changes work at once; Save to controller keeps them.`
        : 'Changes work at once; Save to controller keeps them.';
  }

  function adviceFor(axis) {
    const count = meter.count(axis);
    const worst = meter.worstAxis(axis);
    if (mode === 'phob') {
      const set = phobSettings ? phobSettings.snapback[axis] : null;
      return phobAdvice(axis, worst, count, set);
    }
    const pres = DIRECTIONS.filter((d) => d.axis === axis).map((d) => meter.worstPre(d.key)).filter((v) => v !== null);
    return gcuAdvice(axis, worst, pres.length ? Math.max(...pres) : null, count, tuning);
  }

  function renderAdvice() {
    const items = ['x', 'y'].map((axis) => {
      const a = adviceFor(axis);
      const li = document.createElement('li');
      li.className = a.kind;
      const span = document.createElement('span');
      span.textContent = a.text;
      li.append(span);
      if (a.fix && mode === 'gcu' && gcu.canWrite()) {
        const b = document.createElement('button');
        b.className = 'ghost small-btn';
        b.textContent = 'Apply';
        b.disabled = busy;
        b.addEventListener('click', () => apply(a.fix));
        li.append(' ', b);
      }
      return li;
    });
    $('#snapAdvice').replaceChildren(...items);
  }

  function render() {
    frame = 0;
    if (panel.hidden) return;
    $('#snapTitle').textContent = `Snapback: ${side === 'l' ? 'main stick' : 'c-stick'}`;
    $('#snapPhob').hidden = mode !== 'phob';
    $('#snapGcu').hidden = mode !== 'gcu';
    $('#snapStick').hidden = mode !== 'gcu';
    $('#snapAfter').textContent = mode === 'phob'
      ? 'After any change: test again, then turn safe mode back on (A + X + Y + Start).'
      : 'After any change: clear the table and test again.';
    renderRows();
    renderSettings();
    renderAdvice();
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };

  async function loadTuning() {
    if (mode !== 'gcu') return;
    try {
      tuning = await gcu.tuning(side);
    } catch (e) {
      tuning = null;
      toast(`Couldn't read the snapback settings: ${e.message || e}`, 'error');
    }
    schedule();
  }

  async function apply(patch) {
    if (busy) return;
    busy = true;
    schedule();
    try {
      tuning = await gcu.setTuning(side, patch);
      meter.clear();
      toast(`Snapback filter: ${TYPE_TEXT[gcuType(tuning.snapbackType)]}${gcuType(tuning.snapbackType) === 'lowpass' ? ` ${hz(tuning.snapbackIntensity)}` : ''}. Test again.`, 'ok');
    } catch (e) {
      toast(`Couldn't change the filter: ${e.message || e}`, 'error');
    } finally {
      busy = false;
      schedule();
    }
  }

  $('#snapClose').addEventListener('click', () => api.stop());
  $('#snapClear').addEventListener('click', () => { meter.clear(); schedule(); });
  for (const b of $('#snapType').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const v = b.dataset.v;
      const patch = { snapbackType: GCU_TYPES[v] };
      if (v === 'lowpass' && tuning && (tuning.snapbackIntensity < GCU_CUTOFF.min || tuning.snapbackIntensity > GCU_CUTOFF.max)) patch.snapbackIntensity = GCU_CUTOFF.standard;
      apply(patch);
    });
  }
  $('#snapCut').addEventListener('input', () => { $('#snapCutVal').textContent = hz(Number($('#snapCut').value)); });
  $('#snapCut').addEventListener('change', () => apply({ snapbackType: GCU_TYPES.lowpass, snapbackIntensity: Number($('#snapCut').value) }));
  for (const b of $('#snapStick').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      side = b.dataset.v;
      for (const o of $('#snapStick').querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
      meter.clear();
      loadTuning();
    });
  }

  const api = {
    get active() { return !panel.hidden; },
    start(kind) {
      mode = kind;
      side = 'l';
      for (const o of $('#snapStick').querySelectorAll('button')) o.setAttribute('aria-pressed', String(o.dataset.v === 'l'));
      meter.clear();
      reader = createPhobSettingsReader();
      tuning = null;
      panel.hidden = false;
      loadTuning();
      schedule();
    },
    feedPad(p, rep) {
      if (panel.hidden || mode !== 'phob') return;
      meter.feed({ t: p.at, x: rep.game.lx, y: rep.game.ly });
      reader.feed({ t: p.at, buttons: p.buttons, main: p.main, c: p.c, l: p.l, r: p.r });
      const got = reader.take();
      if (got) {
        phobSettings = { ...(phobSettings ?? {}), ...got };
        if (got.kind === 'snapback') meter.clear();
      }
      if (got || meter.changed !== seen) { seen = meter.changed; schedule(); }
    },
    feedGcu(rep) {
      if (panel.hidden || mode !== 'gcu') return;
      meter.feed({
        t: performance.now(),
        x: toGc(rep, rep.game[`${side}x`]),
        y: toGc(rep, rep.game[`${side}y`]),
        preX: toGc(rep, rep.pre[`${side}x`]),
        preY: toGc(rep, rep.pre[`${side}y`]),
      });
      if (meter.changed !== seen) { seen = meter.changed; schedule(); }
    },
    refresh() { schedule(); },
    reload() { if (!panel.hidden) loadTuning(); },
    stop() { panel.hidden = true; },
  };
  return api;
}
