import {
  RULESET, STATUS_TEXT, buildReport, createReachMeter, createRestMeter, createTriggerMeter, reachResult, reportText, summary,
} from './legality.js';

const STEPS = [
  { key: 'rest', label: 'Let go', title: 'Let go of everything', do: 'Let go of both sticks and both triggers, and wait a moment.' },
  { key: 'main', label: 'Main stick', title: 'Main stick reach', do: 'Roll the main stick slowly around the edge, all the way around, then let go.' },
  { key: 'c', label: 'C-stick', title: 'C-stick reach', do: 'Roll the c-stick slowly around the edge, all the way around, then let go.' },
  { key: 'l', label: 'L', title: 'L trigger', do: 'Press L slowly all the way down, until it clicks, then let go.' },
  { key: 'r', label: 'R', title: 'R trigger', do: 'Press R slowly all the way down, until it clicks, then let go.' },
  { key: 'report', label: 'Report', title: 'Tournament check' },
];

export function createTourneyCheck({ root, toast }) {
  const $ = (s) => root.querySelector(s);
  const panel = $('#legal');
  let step = 0;
  let phob = true;
  let restMeter;
  let rest;
  let reach;
  let trig;
  let rows = [];
  let frame = 0;

  function reset() {
    step = 0;
    restMeter = createRestMeter();
    rest = null;
    reach = { main: createReachMeter(), c: createReachMeter() };
    trig = { l: createTriggerMeter(), r: createTriggerMeter() };
    rows = [];
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; render(); });
  }

  function next() {
    step = Math.min(step + 1, STEPS.length - 1);
    if (STEPS[step].key === 'report') {
      rows = buildReport({
        phob,
        reach: { main: reachResult(reach.main), c: reachResult(reach.c) },
        rest: rest ? { l: rest.l, r: rest.r } : null,
        triggers: { l: trig.l.result(), r: trig.r.result() },
      });
    }
    schedule();
  }

  function progress() {
    const k = STEPS[step].key;
    if (k === 'rest') return 'Waiting for the sticks to settle...';
    if (k === 'main' || k === 'c') {
      const m = reach[k];
      const f = m.farthest;
      return `${Math.round(m.coverage * 100)}% of the way around${f.r ? `, farthest so far ${f.r.toFixed(1)} units` : ''}.${m.coverage === 1 ? ' Now let go.' : ''}`;
    }
    if (k === 'l' || k === 'r') {
      const m = trig[k];
      return m.active ? `Pressed, up to ${m.max}. Let go to finish.` : 'Waiting for a press...';
    }
    return '';
  }

  function render() {
    const s = STEPS[step];
    $('#legalTitle').textContent = s.title;
    $('#legalSteps').replaceChildren(...STEPS.map((t, i) => {
      const li = document.createElement('li');
      li.textContent = t.label;
      if (i < step) li.className = 'done';
      if (i === step) li.className = 'now';
      return li;
    }));
    const reporting = s.key === 'report';
    $('#legalRun').hidden = reporting;
    $('#legalReport').hidden = !reporting;
    if (!reporting) {
      $('#legalDo').textContent = s.do;
      $('#legalProgress').textContent = progress();
      const m = s.key === 'main' || s.key === 'c' ? reach[s.key].coverage : null;
      $('#legalBar').hidden = m === null;
      if (m !== null) $('#legalBarFill').style.width = `${m * 100}%`;
      $('#legalSkip').hidden = s.key === 'rest';
      return;
    }
    const sum = summary(rows);
    $('#legalSummary').textContent = sum.text;
    $('#legalSummary').className = `legal-summary ${sum.status}`;
    $('#legalRows').replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      const st = document.createElement('td');
      st.textContent = STATUS_TEXT[r.status];
      st.className = `legal-status ${r.status}`;
      const rule = document.createElement('td');
      const name = document.createElement('b');
      name.textContent = r.rule;
      const ref = document.createElement('div');
      ref.className = 'muted small';
      ref.textContent = r.ref;
      rule.append(name, ref);
      const text = document.createElement('td');
      text.textContent = r.text;
      tr.append(st, rule, text);
      return tr;
    }));
    $('#legalSource').textContent = `Checked against ${RULESET.repo} at ${RULESET.commit} (${RULESET.date}). A self-check, not a ruling: the TO decides.`;
  }

  async function copy() {
    const text = reportText(rows, { controller: phob ? 'PhobGCC' : 'other' });
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Report copied.', 'ok');
  }

  $('#legalClose').addEventListener('click', () => api.stop());
  $('#legalSkip').addEventListener('click', () => next());
  $('#legalAgain').addEventListener('click', () => { reset(); schedule(); });
  $('#legalCopy').addEventListener('click', () => copy());
  for (const b of $('#legalKind').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      phob = b.dataset.v === 'phob';
      for (const o of $('#legalKind').querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
      if (STEPS[step].key === 'report') { step--; next(); }
    });
  }

  const api = {
    get active() { return !panel.hidden; },
    start() {
      reset();
      panel.hidden = false;
      schedule();
    },
    feedPad(p) {
      if (panel.hidden) return;
      const k = STEPS[step].key;
      const before = progress();
      if (k === 'rest') {
        restMeter.feed({ t: p.at, buttons: p.buttons.size, mx: p.main.x, my: p.main.y, cx: p.c.x, cy: p.c.y, l: p.l, r: p.r });
        if (restMeter.rest) {
          rest = restMeter.rest;
          trig.l.setRest(rest.l);
          trig.r.setRest(rest.r);
          next();
        }
      } else if (k === 'main') {
        reach.main.feed(p.main.x - rest.mx, p.main.y - rest.my);
        if (reach.main.done) next();
      } else if (k === 'c') {
        reach.c.feed(p.c.x - rest.cx, p.c.y - rest.cy);
        if (reach.c.done) next();
      } else if (k === 'l' || k === 'r') {
        trig[k].feed({ t: p.at, analog: k === 'l' ? p.l : p.r, digital: p.buttons.has(k.toUpperCase()) });
        if (trig[k].done) next();
      }
      if (progress() !== before) schedule();
    },
    stop() { panel.hidden = true; },
  };
  return api;
}
