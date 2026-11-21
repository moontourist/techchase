import { GC_CODES, INPUT, codeName } from './gcu-protocol.js';
import { NOTCHES, fmtMelee, gcAxis, gcTrigger, meleeUnits, nearestNotch, notchError } from './melee.js';

const SVG = 'http://www.w3.org/2000/svg';
const TRAIL = 45;
const SCOPE_MS = 2500;
const HOLD_MS = 250;
const GC_BUTTONS = ['A', 'B', 'X', 'Y', 'Z', 'L', 'R', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
const BUTTON_TEXT = { START: 'Start', UP: '▲', DOWN: '▼', LEFT: '◀', RIGHT: '▶' };

const pad = (n, w = 4) => String(n).padStart(w, ' ');
const fmtRaw = (x, y) => `(${pad(x)}, ${pad(y)})`;

function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function stickView(svg) {
  svg.setAttribute('viewBox', '-128 -128 256 256');
  const g = el('g', { transform: 'scale(1,-1)' }, svg);
  el('rect', { x: -128, y: -128, width: 256, height: 256, class: 'bg' }, g);
  for (const n of NOTCHES) {
    const a = (n.deg * Math.PI) / 180;
    el('line', { x1: 0, y1: 0, x2: 120 * Math.cos(a), y2: 120 * Math.sin(a), class: 'ray' }, g);
  }
  const gate = el('polygon', { class: 'gate' }, g);
  el('circle', { r: 80, class: 'melee-circle' }, g);
  el('rect', { x: -22.5, y: -22.5, width: 45, height: 45, class: 'deadzone' }, g);
  const notchDots = el('g', { class: 'notch-dots' }, g);
  const trail = el('polyline', { class: 'trail' }, g);
  const pre = el('circle', { r: 5, class: 'pre' }, g);
  const dot = el('circle', { r: 5.5, class: 'dot' }, g);
  return { gate, notchDots, trail, pre, dot };
}

export function createLive({ root, entries }) {
  const views = { l: stickView(root.querySelector('#liveL')), r: stickView(root.querySelector('#liveR')) };
  const stick = {
    l: { trail: [], notches: Array(8).fill(null), hold: null },
    r: { trail: [], notches: Array(8).fill(null), hold: null },
  };
  const scope = [];
  let latest = null;
  let frame = 0;
  let notchStick = 'l';
  let scopeStick = 'l';
  let scopeAxis = 'x';
  let reports = [];
  let lastSeq = null;
  let dropped = 0;

  const btnBox = root.querySelector('#liveButtons');
  btnBox.textContent = '';
  const btnEls = new Map();
  for (const b of GC_BUTTONS) {
    const s = document.createElement('span');
    s.className = `gcb gcb-${b.toLowerCase()}`;
    s.textContent = BUTTON_TEXT[b] || b;
    btnBox.appendChild(s);
    btnEls.set(b, s);
  }

  function seg(sel, onPick) {
    for (const b of root.querySelectorAll(`${sel} button`)) {
      b.addEventListener('click', () => {
        for (const x of root.querySelectorAll(`${sel} button`)) x.setAttribute('aria-pressed', String(x === b));
        onPick(b.dataset.v);
      });
    }
  }
  seg('#notchStick', (v) => { notchStick = v; renderNotches(); });
  seg('#scopeStick', (v) => { scopeStick = v; });
  seg('#scopeAxis', (v) => { scopeAxis = v; });
  root.querySelector('#notchClear').addEventListener('click', () => {
    stick[notchStick].notches = Array(8).fill(null);
    renderNotches();
    drawGates();
  });

  function gc(s, k) { return { x: gcAxis(s[`${k}x`]), y: gcAxis(s[`${k}y`]) }; }

  function capture(which, p, now) {
    const st = stick[which];
    const i = nearestNotch(p.x, p.y);
    if (i === null) { st.hold = null; return; }
    if (!st.hold || st.hold.i !== i || Math.abs(st.hold.x - p.x) > 1 || Math.abs(st.hold.y - p.y) > 1) {
      st.hold = { i, x: p.x, y: p.y, since: now, done: false };
      return;
    }
    if (!st.hold.done && now - st.hold.since >= HOLD_MS) {
      st.hold.done = true;
      st.notches[i] = { x: p.x, y: p.y, melee: meleeUnits(p.x, p.y) };
      if (which === notchStick) renderNotches();
      drawGates();
    }
  }

  function push(rep) {
    const now = performance.now();
    latest = rep;
    reports.push(now);
    if (rep.seq !== null) {
      if (lastSeq !== null) dropped += (rep.seq - lastSeq - 1 + 256) % 256;
      lastSeq = rep.seq;
    }
    for (const k of ['l', 'r']) {
      const p = gc(rep.game, k);
      stick[k].trail.push(p);
      if (stick[k].trail.length > TRAIL) stick[k].trail.shift();
      capture(k, p, now);
    }
    scope.push({ t: now, game: rep.game, pre: rep.pre });
    while (scope.length && now - scope[0].t > SCOPE_MS) scope.shift();
  }

  function drawGates() {
    for (const k of ['l', 'r']) {
      const got = stick[k].notches;
      const pts = NOTCHES.map((n, i) => {
        if (got[i]) return [got[i].x, got[i].y];
        const a = (n.deg * Math.PI) / 180;
        const r = n.deg % 90 ? 98 : 103;
        return [r * Math.cos(a), r * Math.sin(a)];
      });
      views[k].gate.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      views[k].gate.classList.toggle('measured', got.some(Boolean));
      const dots = views[k].notchDots;
      dots.textContent = '';
      for (const [i, n] of got.entries()) {
        if (!n) continue;
        el('circle', { cx: n.x, cy: n.y, r: 3.2, class: notchError(i, n.melee) === 0 ? 'ok' : notchError(i, n.melee) <= 1 ? 'near' : 'off' }, dots);
      }
    }
  }

  function renderNotches() {
    const body = root.querySelector('#notchRows');
    body.textContent = '';
    const got = stick[notchStick].notches;
    for (const [i, n] of NOTCHES.entries()) {
      const tr = document.createElement('tr');
      const m = got[i];
      const err = m ? notchError(i, m.melee) : null;
      const cells = [n.name, m ? fmtRaw(m.x, m.y) : '--', m ? `(${fmtMelee(m.melee[0])}, ${fmtMelee(m.melee[1])})` : '--',
        m ? (err === 0 ? 'on target' : `${err} off`) : 'hold it here'];
      for (const [j, c] of cells.entries()) {
        const td = document.createElement('td');
        td.textContent = c;
        if (j === 3) td.className = m ? (err === 0 ? 'ok' : err <= 1 ? 'near' : 'off') : 'muted';
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    const n = got.filter(Boolean).length;
    root.querySelector('#notchSummary').textContent = n
      ? `${n} of 8 measured. Ideal: 1.0000 on the cardinals, 0.7000 on both axes on the diagonals.`
      : 'Push the stick to the rim and hold it still in each direction.';
  }

  function drawScope() {
    const c = root.querySelector('#scope');
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(root);
    const y = (v) => h / 2 - (v / 128) * (h / 2 - 6);
    ctx.lineWidth = 1;
    ctx.strokeStyle = css.getPropertyValue('--border-muted');
    ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(w, y(0)); ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = css.getPropertyValue('--color-success');
    for (const v of [23, -23]) { ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(w, y(v)); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = css.getPropertyValue('--text-muted');
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillText('+23', 4, y(23) - 4);
    ctx.fillText('-23', 4, y(-23) + 12);
    const now = performance.now();
    const key = `${scopeStick}${scopeAxis}`;
    for (const [src, color, width] of [['pre', '--accent-tertiary', 1.2], ['game', '--accent-secondary', 2]]) {
      ctx.strokeStyle = css.getPropertyValue(color);
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [i, s] of scope.entries()) {
        const x = w - ((now - s.t) / SCOPE_MS) * w;
        const v = gcAxis(s[src][key]);
        if (i === 0) ctx.moveTo(x, y(v)); else ctx.lineTo(x, y(v));
      }
      ctx.stroke();
    }
  }

  function draw() {
    if (!latest) return;
    const now = performance.now();
    reports = reports.filter((t) => now - t < 1000);
    for (const k of ['l', 'r']) {
      const v = views[k];
      const p = gc(latest.game, k);
      const q = gc(latest.pre, k);
      v.dot.setAttribute('cx', p.x); v.dot.setAttribute('cy', p.y);
      v.pre.setAttribute('cx', q.x); v.pre.setAttribute('cy', q.y);
      v.trail.setAttribute('points', stick[k].trail.map((t) => `${t.x},${t.y}`).join(' '));
      const [mx, my] = meleeUnits(p.x, p.y);
      root.querySelector(`#raw${k.toUpperCase()}`).textContent = fmtRaw(p.x, p.y);
      root.querySelector(`#mel${k.toUpperCase()}`).textContent = `(${fmtMelee(mx)}, ${fmtMelee(my)})`;
      root.querySelector(`#pre${k.toUpperCase()}`).textContent = fmtRaw(q.x, q.y);
    }

    const lit = new Set();
    const physical = [];
    for (const e of entries()) {
      if (!latest.presses.has(e.code)) continue;
      const out = codeName(GC_CODES, e.gcCur);
      if (out) lit.add(out);
      if (e.name !== 'LT' && e.name !== 'RT') physical.push(e.gcCur === e.gcDef || !out ? e.name : `${e.name} → ${out}`);
    }
    for (const [b, s] of btnEls) s.classList.toggle('on', lit.has(b));
    root.querySelector('#livePressed').textContent = physical.length ? physical.join('  ') : 'nothing pressed';

    for (const [side, val, dig] of [['L', latest.lt, lit.has('L') || latest.presses.has(INPUT.L)], ['R', latest.rt, lit.has('R') || latest.presses.has(INPUT.R)]]) {
      const v = gcTrigger(val, dig);
      root.querySelector(`#trig${side}`).style.width = `${(v / 255) * 100}%`;
      root.querySelector(`#trig${side}Val`).textContent = pad(v, 3);
      root.querySelector(`#trig${side}Dig`).classList.toggle('on', dig);
    }

    root.querySelector('#liveRate').textContent = `${reports.length} reports/s`;
    root.querySelector('#liveDrops').textContent = latest.seq === null ? '' : `${dropped} dropped`;
    root.querySelector('#liveCoarse').hidden = latest.full;
    drawScope();
  }

  function loop() {
    draw();
    frame = requestAnimationFrame(loop);
  }

  renderNotches();
  drawGates();
  return {
    push,
    start() { if (!frame) frame = requestAnimationFrame(loop); },
    stop() { cancelAnimationFrame(frame); frame = 0; },
    reset() {
      latest = null; scope.length = 0; dropped = 0; lastSeq = null; reports = [];
      for (const k of ['l', 'r']) { stick[k].trail = []; stick[k].hold = null; }
    },
  };
}
