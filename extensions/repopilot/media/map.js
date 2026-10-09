// RepoPilot dependency map — dependency-free force layout on <canvas>.
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('graph');
  const ctx = canvas.getContext('2d');
  const tip = document.getElementById('tip');
  const details = document.getElementById('details');
  const legend = document.getElementById('legend');
  const stats = document.getElementById('stats');
  const search = document.getElementById('search');
  const hideIsolated = document.getElementById('hideIsolated');
  const btnModules = document.getElementById('modeModules');
  const btnFiles = document.getElementById('modeFiles');

  const css = name => getComputedStyle(document.body).getPropertyValue(name).trim();
  const PALETTE = ['#4E79A7', '#F28E2B', '#59A14F', '#E15759', '#76B7B2', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#86BCB6', '#D37295', '#A0CBE8'];

  let data = null, mode = 'modules', nodes = [], links = [], byId = new Map();
  let groupColor = new Map();
  let view = { x: 0, y: 0, k: 1 };
  let alpha = 0, hover = null, selected = null, drag = null, pan = null, filter = '';
  let dpr = window.devicePixelRatio || 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, r.width * dpr);
    canvas.height = Math.max(1, r.height * dpr);
    draw();
  }
  window.addEventListener('resize', resize);

  function colorFor(n) {
    const key = n.group;
    if (!groupColor.has(key)) groupColor.set(key, PALETTE[groupColor.size % PALETTE.length]);
    return groupColor.get(key);
  }

  function build() {
    if (!data) return;
    const src = mode === 'modules' ? data.modules : data.files;
    const linked = new Set();
    src.links.forEach(l => { linked.add(l.source); linked.add(l.target); });
    const keep = src.nodes.filter(n => !hideIsolated.checked || linked.has(n.id) || mode === 'modules' && src.nodes.length < 4);
    const old = byId;
    byId = new Map();
    nodes = keep.map((n, i) => {
      const prev = old.get(n.id);
      const a = (i / keep.length) * Math.PI * 2, r = 40 + 8 * Math.sqrt(keep.length) * (0.5 + Math.random());
      const node = Object.assign({}, n, {
        x: prev ? prev.x : Math.cos(a) * r, y: prev ? prev.y : Math.sin(a) * r, vx: 0, vy: 0,
        r: mode === 'modules' ? 6 + Math.sqrt(n.size) * 2.2 : 3 + Math.min(14, Math.sqrt(n.inDeg) * 2.5)
      });
      byId.set(n.id, node);
      return node;
    });
    links = src.links.filter(l => byId.has(l.source) && byId.has(l.target)).map(l => ({ s: byId.get(l.source), t: byId.get(l.target), w: l.weight, kind: l.kind }));
    groupColor = new Map();
    [...new Set(nodes.map(n => n.group))].forEach(g => colorFor({ group: g }));
    renderLegend();
    stats.textContent = `${nodes.length} ${mode === 'modules' ? 'modules' : 'files'} · ${links.length} links` +
      (mode === 'files' && data.files.omitted ? ` · ${data.files.omitted} less-connected files hidden` : '');
    alpha = 1;
    selected = selected && byId.get(selected.id) || null;
    showDetails();
    if (!old.size) fitSoon();
    tick();
  }

  function renderLegend() {
    const groups = [...groupColor.entries()].slice(0, 14);
    legend.innerHTML = '';
    if (mode !== 'files') { legend.hidden = true; return; }
    legend.hidden = false;
    for (const [g, c] of groups) {
      const row = document.createElement('div');
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = c;
      row.append(sw, document.createTextNode(g));
      legend.append(row);
    }
  }

  function step() {
    const n = nodes.length;
    const rep = mode === 'modules' ? 2600 : 900;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.25; }
        if (d2 > 250000) continue;
        const f = (rep * alpha) / d2, d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
    }
    const len = mode === 'modules' ? 140 : 60;
    for (const l of links) {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - len) / d) * 0.06 * alpha;
      l.s.vx += dx * f; l.s.vy += dy * f; l.t.vx -= dx * f; l.t.vy -= dy * f;
    }
    for (const p of nodes) {
      p.vx -= p.x * 0.004 * alpha; p.vy -= p.y * 0.004 * alpha;
      if (p === drag?.node) { p.vx = p.vy = 0; continue; }
      p.vx *= 0.6; p.vy *= 0.6;
      p.x += p.vx; p.y += p.vy;
    }
    alpha *= 0.985;
  }

  let raf = 0;
  function tick() {
    cancelAnimationFrame(raf);
    const loop = () => {
      if (alpha > 0.02) { step(); step(); }
      draw();
      if (alpha > 0.02 || drag) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  const toScreen = p => ({ x: (p.x * view.k + view.x) * dpr + canvas.width / 2, y: (p.y * view.k + view.y) * dpr + canvas.height / 2 });
  function toWorld(cx, cy) {
    const r = canvas.getBoundingClientRect();
    return { x: ((cx - r.left) - r.width / 2 - view.x) / view.k, y: ((cy - r.top) - r.height / 2 - view.y) / view.k };
  }

  function matches(n) {
    if (!filter) return true;
    return n.id.toLowerCase().includes(filter);
  }

  function neighbours(n) {
    const s = new Set([n]);
    for (const l of links) { if (l.s === n) s.add(l.t); if (l.t === n) s.add(l.s); }
    return s;
  }

  function draw() {
    const fg = css('--vscode-editor-foreground') || '#ccc';
    const muted = css('--vscode-descriptionForeground') || '#888';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const focus = selected || hover;
    const near = focus ? neighbours(focus) : null;

    ctx.lineWidth = dpr;
    for (const l of links) {
      const a = toScreen(l.s), b = toScreen(l.t);
      const on = near && (l.s === focus || l.t === focus);
      const dim = (near && !on) || (filter && !(matches(l.s) || matches(l.t)));
      ctx.globalAlpha = dim ? 0.06 : on ? 0.95 : 0.28;
      ctx.strokeStyle = on ? (l.s === focus ? '#F28E2B' : '#4E79A7') : muted;
      ctx.lineWidth = (mode === 'modules' ? Math.min(6, 1 + Math.log2(l.w)) : 1) * dpr;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      // arrow head
      const ang = Math.atan2(b.y - a.y, b.x - a.x), rr = (l.t.r * view.k + 2) * dpr;
      const hx = b.x - Math.cos(ang) * rr, hy = b.y - Math.sin(ang) * rr, hs = 5 * dpr;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(hx, hy);
      ctx.lineTo(hx - Math.cos(ang - 0.45) * hs, hy - Math.sin(ang - 0.45) * hs);
      ctx.lineTo(hx - Math.cos(ang + 0.45) * hs, hy - Math.sin(ang + 0.45) * hs);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const showLabels = mode === 'modules' || view.k > 1.3 || nodes.length < 60;
    ctx.font = `${11 * dpr}px ${css('--vscode-font-family') || 'sans-serif'}`;
    ctx.textAlign = 'center';
    for (const n of nodes) {
      const p = toScreen(n);
      const dim = (near && !near.has(n)) || !matches(n);
      ctx.globalAlpha = dim ? 0.15 : 1;
      ctx.fillStyle = colorFor(n);
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(2, n.r * view.k) * dpr, 0, Math.PI * 2); ctx.fill();
      if (n === selected) { ctx.strokeStyle = fg; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
      if ((showLabels || n === focus || (near && near.has(n)) || (filter && matches(n))) && !dim) {
        ctx.fillStyle = fg;
        ctx.fillText(n.label, p.x, p.y - (n.r * view.k + 4) * dpr);
      }
    }
    ctx.globalAlpha = 1;
  }

  function hit(cx, cy) {
    const w = toWorld(cx, cy);
    let best = null, bd = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < Math.max(n.r, 6 / view.k) && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  canvas.addEventListener('mousedown', e => {
    const n = hit(e.clientX, e.clientY);
    if (n) { drag = { node: n, moved: false }; alpha = Math.max(alpha, 0.3); tick(); }
    else pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  });
  window.addEventListener('mousemove', e => {
    if (drag) {
      const w = toWorld(e.clientX, e.clientY);
      drag.node.x = w.x; drag.node.y = w.y; drag.moved = true;
      return;
    }
    if (pan) {
      view.x = pan.vx + (e.clientX - pan.x); view.y = pan.vy + (e.clientY - pan.y);
      pan.moved = pan.moved || Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 3;
      draw(); return;
    }
    const n = hit(e.clientX, e.clientY);
    if (n !== hover) { hover = n; draw(); }
    if (n) {
      tip.hidden = false;
      tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 10 + 'px';
      tip.textContent = mode === 'modules'
        ? `${n.id}\n${n.size} files · uses ${n.outDeg} · used by ${n.inDeg}`
        : `${n.id}\n${n.lang} · ${n.size} lines\nimports ${n.outDeg} · used by ${n.inDeg}`;
    } else tip.hidden = true;
  });
  window.addEventListener('mouseup', e => {
    if (drag) {
      if (!drag.moved) { selected = drag.node === selected ? null : drag.node; showDetails(); }
      drag = null; draw();
    } else if (pan) {
      if (!pan.moved && e.target === canvas) { selected = null; showDetails(); draw(); }
      pan = null;
    }
  });
  canvas.addEventListener('dblclick', e => {
    const n = hit(e.clientX, e.clientY);
    if (!n) return;
    if (mode === 'files') vscode.postMessage({ type: 'open', file: n.id });
    else { search.value = n.id === '(root)' ? '' : n.id; filter = search.value.toLowerCase(); setMode('files'); }
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    const k = Math.min(8, Math.max(0.1, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - ((mx - view.x) * k) / view.k; view.y = my - ((my - view.y) * k) / view.k; view.k = k;
    draw();
  }, { passive: false });

  function showDetails() {
    if (!selected) { details.hidden = true; return; }
    const n = selected;
    const outs = links.filter(l => l.s === n).map(l => l.t.id);
    const ins = links.filter(l => l.t === n).map(l => l.s.id);
    details.hidden = false;
    details.innerHTML = '';
    const h = document.createElement('h3'); h.textContent = n.id; details.append(h);
    const meta = document.createElement('p');
    meta.textContent = mode === 'modules' ? `${n.size} files` : `${n.lang} · ${n.size} lines`;
    details.append(meta);
    const list = (title, items, cls) => {
      const t = document.createElement('h4'); t.textContent = `${title} (${items.length})`; details.append(t);
      const ul = document.createElement('ul'); ul.className = cls;
      items.slice(0, 40).forEach(id => {
        const li = document.createElement('li'); li.textContent = id; li.title = id;
        li.onclick = () => { selected = byId.get(id); showDetails(); draw(); };
        ul.append(li);
      });
      details.append(ul);
    };
    list('Uses', outs, 'out');
    list('Used by', ins, 'in');
    if (mode === 'files') {
      const row = document.createElement('div'); row.className = 'actions';
      const open = document.createElement('button'); open.textContent = 'Open file';
      open.onclick = () => vscode.postMessage({ type: 'open', file: n.id });
      const imp = document.createElement('button'); imp.textContent = 'Impact (who uses this)';
      imp.onclick = () => vscode.postMessage({ type: 'dependents', file: n.id });
      row.append(open, imp); details.append(row);
    } else {
      const row = document.createElement('div'); row.className = 'actions';
      const drill = document.createElement('button'); drill.textContent = 'Show files in module';
      drill.onclick = () => { search.value = n.id === '(root)' ? '' : n.id; filter = search.value.toLowerCase(); setMode('files'); };
      row.append(drill); details.append(row);
    }
  }

  function fit() {
    if (!nodes.length) return;
    const r = canvas.getBoundingClientRect();
    const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const k = Math.min(3, 0.85 * Math.min(r.width / (maxX - minX + 80), r.height / (maxY - minY + 80)));
    view.k = isFinite(k) && k > 0 ? k : 1;
    view.x = -((minX + maxX) / 2) * view.k; view.y = -((minY + maxY) / 2) * view.k;
    draw();
  }
  function fitSoon() { setTimeout(fit, 900); setTimeout(fit, 2500); }

  function setMode(m) {
    mode = m;
    btnModules.classList.toggle('active', m === 'modules');
    btnFiles.classList.toggle('active', m === 'files');
    byId = new Map(); selected = null;
    build(); fitSoon();
  }

  btnModules.onclick = () => setMode('modules');
  btnFiles.onclick = () => setMode('files');
  document.getElementById('fit').onclick = fit;
  hideIsolated.onchange = () => build();
  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); draw(); });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type !== 'data') return;
    const first = !data;
    data = msg.data;
    if (msg.focus) {
      mode = 'files';
      btnModules.classList.remove('active'); btnFiles.classList.add('active');
    }
    build();
    if (msg.focus && byId.has(msg.focus)) { selected = byId.get(msg.focus); showDetails(); }
    if (first) { resize(); fitSoon(); }
  });

  resize();
  vscode.postMessage({ type: 'ready' });
})();
