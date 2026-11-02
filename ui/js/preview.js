'use strict';
const frame = $('#frame'), layersEl = $('#layers'), audioBox = $('#audiobox'), xbox = $('#xbox');
const RT = new Map();           // clip id -> runtime {wrap, el, mb, mbx, vg, cv, used}
let viewT = 0;                  // the time currently shown (hover or playhead)
const clipById = id => P.clips.find(c => c.id === id) || null;

function fitFrame() {
  const [a, b] = P.ratio.split(':').map(Number), st = $('#stage');
  let w = st.clientWidth, h = w * b / a;
  if (h > st.clientHeight) { h = st.clientHeight; w = h * a / b; }
  frame.style.width = Math.max(40, w) + 'px'; frame.style.height = Math.max(40, h) + 'px';
}

/* ---------------------------------------------------------------- runtime elements */
function createRT(c) {
  if (RT.size > 18) {                                   // keep decoder count bounded
    const old = [...RT.entries()].filter(([, r]) => r.wrap.style.display === 'none').sort((a, b) => a[1].used - b[1].used)[0];
    if (old) dropRT(old[0]);
  }
  const wrap = document.createElement('div'); wrap.className = 'layer'; wrap.dataset.id = c.id;
  let el;
  if (c.kind === 'video' || c.kind === 'audio') {
    el = document.createElement(c.kind === 'video' ? 'video' : 'audio');
    el.preload = 'auto'; el.playsInline = true; el.src = S[c.src].url;
  } else { el = document.createElement('img'); el.draggable = false; if (c.kind === 'image') el.src = S[c.src].url; }
  const r = { wrap, el, used: performance.now() };
  if (c.kind === 'audio') audioBox.appendChild(el);
  else {
    wrap.appendChild(el);
    r.vg = Object.assign(document.createElement('div'), { className: 'vg' });
    r.mb = Object.assign(document.createElement('div'), { className: 'mb' });
    r.mbx = Object.assign(document.createElement('div'), { className: 'mbx', innerHTML: '<i></i>' });
    wrap.append(r.vg, r.mb, r.mbx);
    layersEl.appendChild(wrap);
    wrap.addEventListener('pointerdown', e => {
      if (e.target.closest('.mbx')) return;
      const cc = clipById(c.id); if (!cc) return;
      selectClip(cc.id);
      if (!isMain(cc) && !trk(cc.track).lock) startDrag('move', e, cc);
    });
    bindMaskDrag(c.id, r);
  }
  if (c.kind === 'video') el.addEventListener('seeked', () => { const cc = clipById(c.id); if (cc && cc.chroma.on && r.cv) drawKey(cc, r); });
  RT.set(c.id, r); return r;
}
function dropRT(id) {
  const r = RT.get(id); if (!r) return;
  try { r.el.pause && r.el.pause(); r.el.removeAttribute('src'); r.el.load && r.el.load(); } catch (_) { }
  r.wrap.remove(); r.el.remove(); RT.delete(id);
}
function gcRuntime() { for (const id of [...RT.keys()]) if (!clipById(id)) dropRT(id); }
function resetRuntime() { for (const id of [...RT.keys()]) dropRT(id); }
function retargetSources() {            // preview quality changed: swap urls but keep each element's time
  for (const [id, r] of RT) {
    const c = clipById(id); if (!c || !c.src || !S[c.src] || c.kind === 'image') continue;
    const t = r.el.currentTime, u = S[c.src].url;
    if (r.el.getAttribute('src') === u) continue;
    r.el.addEventListener('loadedmetadata', () => { r.el.currentTime = t; }, { once: true });
    r.el.src = u;
  }
}

/* ---------------------------------------------------------------- layout of one layer */
function cssFx(f, fh) {
  let s = `brightness(${1 + f.brightness / 200}) contrast(${1 + f.contrast / 100}) saturate(${1 + f.saturation / 100})`;
  if (f.blur > 0) s += ` blur(${f.blur * fh / 1080}px)`;
  s += { bw: ' grayscale(1)', sepia: ' sepia(1)', warm: ' sepia(.3) saturate(1.3)', cool: ' hue-rotate(12deg) saturate(1.1)', negative: ' invert(1)' }[f.filter] || '';
  return s;
}
function layerSize(c, FW, FH) {
  if (c.kind === 'text' || c.kind === 'sticker') { const b = bitmap(c, FH); return { w: b.w, h: b.h, url: b.url }; }
  const s = S[c.src], k = Math.min(FW / s.w, FH / s.h);
  return { w: s.w * k, h: s.h * k };
}
function layout(c, r, t) {
  const FW = frame.clientWidth, FH = frame.clientHeight, main = isMain(c), tl = clamp(t - c.start, 0, c.dur);
  const w = r.wrap.style;
  if (c.kind === 'text' || c.kind === 'sticker') { const z = layerSize(c, FW, FH); if (r.el.getAttribute('src') !== z.url) r.el.src = z.url; }
  if (main) {
    w.width = FW + 'px'; w.height = FH + 'px'; w.transform = 'none'; w.opacity = 1; r.el.style.objectFit = 'contain';
  } else {
    const z = layerSize(c, FW, FH), p = evalP(c, tl);
    w.width = z.w + 'px'; w.height = z.h + 'px'; r.el.style.objectFit = 'fill';
    w.transform = `translate(${p.x * FW - z.w / 2}px,${p.y * FH - z.h / 2}px) rotate(${p.r}deg) scale(${Math.max(.01, p.s)})`;
    w.opacity = clamp(p.o, 0, 1) * p.fade;
  }
  if (c.kind === 'video' || c.kind === 'image') {
    const f = cssFx(c.fx, FH);
    r.el.style.filter = f; if (r.cv) r.cv.style.filter = f;
    r.el.style.transform = c.fx.flip ? 'scaleX(-1)' : ''; if (r.cv) r.cv.style.transform = c.fx.flip ? 'scaleX(-1)' : '';
    r.vg.style.opacity = c.fx.filter === 'vignette' ? 1 : 0;
    // chroma-key preview: a canvas replaces the video image
    const ck = c.kind === 'video' && !main && c.chroma.on;
    if (ck && !r.cv) { r.cv = Object.assign(document.createElement('canvas'), { className: 'ck' }); r.wrap.insertBefore(r.cv, r.vg); }
    if (!ck && r.cv) { r.cv.remove(); r.cv = null; }
    r.el.style.opacity = ck ? 0 : 1;
    if (ck) drawKey(c, r);
  }
  updMask(c, r);
}
function hexRGB(h) { const n = parseInt(h, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function drawKey(c, r) {
  const v = r.el; if (!r.cv || v.readyState < 2 || !v.videoWidth) return;
  const W = Math.min(480, v.videoWidth), H = Math.max(2, Math.round(W * v.videoHeight / v.videoWidth));
  if (r.cv.width !== W || r.cv.height !== H) { r.cv.width = W; r.cv.height = H; }
  const x = r.cv.getContext('2d', { willReadFrequently: true });
  x.drawImage(v, 0, 0, W, H);
  const im = x.getImageData(0, 0, W, H), d = im.data, k = hexRGB(c.chroma.color), sim = c.chroma.sim, bl = Math.max(.0001, c.chroma.blend);
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - k[0], dg = d[i + 1] - k[1], db = d[i + 2] - k[2];
    const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.7;
    d[i + 3] = dist <= sim ? 0 : dist >= sim + bl ? d[i + 3] : d[i + 3] * (dist - sim) / bl;
  }
  x.putImageData(im, 0, 0);
}

/* ---------------------------------------------------------------- region-blur mask */
function updMask(c, r) {
  const m = c.mask;
  if (!r.mb) return;
  if (c.kind !== 'video' || !m.on) { r.mb.style.display = r.mbx.style.display = 'none'; return; }
  const pos = { left: m.x * 100 + '%', top: m.y * 100 + '%', width: m.w * 100 + '%', height: m.h * 100 + '%', borderRadius: m.shape === 'ellipse' ? '50%' : '0' };
  Object.assign(r.mb.style, pos, { display: 'block' });
  const b = `blur(${m.blur * frame.clientHeight / 1080}px)`;
  r.mb.style.backdropFilter = r.mb.style.webkitBackdropFilter = b;
  Object.assign(r.mbx.style, pos, { display: (c.id === selId && !playing) ? 'block' : 'none' });
}
function bindMaskDrag(id, r) {
  let d = null;
  r.mbx.addEventListener('pointerdown', e => {
    const c = clipById(id); if (!c || c.id !== selId) return;
    snap();
    const p = isMain(c) ? { r: 0, s: 1 } : evalP(c, clamp(viewT - c.start, 0, c.dur));
    d = { mode: e.target.tagName === 'I' ? 'size' : 'move', sx: e.clientX, sy: e.clientY, o: { ...c.mask }, p, w: r.wrap.offsetWidth || 1, h: r.wrap.offsetHeight || 1 };
    r.mbx.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
  });
  r.mbx.addEventListener('pointermove', e => {
    if (!d) return;
    const c = clipById(id), m = c.mask, o = d.o, a = -d.p.r * Math.PI / 180;
    const ex = e.clientX - d.sx, ey = e.clientY - d.sy;
    const dx = (ex * Math.cos(a) - ey * Math.sin(a)) / d.p.s / d.w, dy = (ex * Math.sin(a) + ey * Math.cos(a)) / d.p.s / d.h;
    if (d.mode === 'move') { m.x = clamp(o.x + dx, 0, 1 - o.w); m.y = clamp(o.y + dy, 0, 1 - o.h); }
    else { m.w = clamp(o.w + dx, .05, 1 - o.x); m.h = clamp(o.h + dy, .05, 1 - o.y); }
    updMask(c, r);
  });
  r.mbx.addEventListener('pointerup', () => { d = null; });
}

/* ---------------------------------------------------------------- compositing at time t */
function syncAt(t, live) {
  viewT = t;
  $('#empty').style.display = P.clips.length ? 'none' : 'block';
  const now = performance.now();
  for (const c of P.clips) {
    const tr = trk(c.track);
    let r = RT.get(c.id);
    const on = !!tr && t >= c.start - 1e-6 && t < cEnd(c) - 1e-6 && (c.kind === 'audio' || !tr.hide);
    if (!on) { if (r) { r.wrap.style.display = 'none'; if (r.el.pause) r.el.pause(); } continue; }
    if (!r) r = createRT(c);
    r.used = now;
    if (c.kind !== 'audio') {
      r.wrap.style.display = 'block';
      r.wrap.style.zIndex = (P.tracks.length - P.tracks.indexOf(tr)) * 2;
      layout(c, r, t);
    }
    if (c.kind === 'video' || c.kind === 'audio') {
      const el = r.el, want = c.in + (t - c.start) * c.speed;
      el.muted = tr.mute; el.volume = clamp(c.vol, 0, 1);
      if (live) {
        if (el.paused) { el.currentTime = want; el.playbackRate = c.speed; el.play().catch(() => { }); }
        else { el.playbackRate = c.speed; if (Math.abs(el.currentTime - want) > .3) el.currentTime = want; }
        if (r.cv) drawKey(c, r);
      } else {
        el.pause();
        if (Math.abs(el.currentTime - want) > .03) el.currentTime = want;
      }
    }
  }
  updBox(t);
}

/* ---------------------------------------------------------------- selection box (move / scale / rotate on canvas) */
let D = null;
function updBox(t) {
  const c = SEL();
  if (!c || playing || isMain(c) || c.kind === 'audio' || !(t >= c.start && t < cEnd(c))) { xbox.style.display = 'none'; return; }
  const FW = frame.clientWidth, FH = frame.clientHeight, z = layerSize(c, FW, FH), p = evalP(c, clamp(t - c.start, 0, c.dur));
  const w = z.w * p.s, h = z.h * p.s;
  Object.assign(xbox.style, {
    display: 'block', width: w + 'px', height: h + 'px',
    transform: `translate(${p.x * FW - w / 2}px,${p.y * FH - h / 2}px) rotate(${p.r}deg)`
  });
}
function startDrag(mode, e, c) {
  const fr = frame.getBoundingClientRect(), tl = clamp(viewT - c.start, 0, c.dur), p = evalP(c, tl);
  snap();
  const cx = fr.left + p.x * fr.width, cy = fr.top + p.y * fr.height;
  D = {
    mode, c, fr, tl, sx: e.clientX, sy: e.clientY, cx, cy,
    x0: chanVal(c, 'x', tl), y0: chanVal(c, 'y', tl), s0: chanVal(c, 's', tl), r0: chanVal(c, 'r', tl),
    d0: Math.max(4, Math.hypot(e.clientX - cx, e.clientY - cy)), a0: Math.atan2(e.clientY - cy, e.clientX - cx)
  };
  e.preventDefault(); e.stopPropagation();
  addEventListener('pointermove', onDrag); addEventListener('pointerup', endDrag, { once: true });
}
function onDrag(e) {
  if (!D) return;
  const { c, fr, tl } = D;
  if (D.mode === 'move') {
    setChan(c, 'x', clamp(D.x0 + (e.clientX - D.sx) / fr.width, -1, 2), tl);
    setChan(c, 'y', clamp(D.y0 + (e.clientY - D.sy) / fr.height, -1, 2), tl);
  } else if (D.mode === 'scale') {
    setChan(c, 's', clamp(D.s0 * Math.hypot(e.clientX - D.cx, e.clientY - D.cy) / D.d0, .05, 8), tl);
  } else {
    let r = D.r0 + (Math.atan2(e.clientY - D.cy, e.clientX - D.cx) - D.a0) * 180 / Math.PI;
    r = ((r + 180) % 360 + 360) % 360 - 180; setChan(c, 'r', Math.round(r), tl);
  }
  syncAt(viewT, false); refreshKfUI();
}
function endDrag() { removeEventListener('pointermove', onDrag); D = null; renderTimeline(); }
$('#xs').addEventListener('pointerdown', e => { const c = SEL(); if (c) startDrag('scale', e, c); });
$('#xr').addEventListener('pointerdown', e => { const c = SEL(); if (c) startDrag('rot', e, c); });

/* ---------------------------------------------------------------- playback */
let _last = 0;
function play() {
  if (!P.clips.length) return;
  if (playhead >= total() - .05) playhead = 0;
  playing = true; _last = performance.now(); $('#play').textContent = '⏸ إيقاف'; $('#hv').style.display = 'none';
  requestAnimationFrame(tick);
}
function pause() {
  playing = false; $('#play').textContent = '▶ تشغيل';
  for (const r of RT.values()) if (r.el.pause) r.el.pause();
  syncAt(playhead, false);
}
const togglePlay = () => playing ? pause() : play();
function tick(now) {
  if (!playing) return;
  playhead += Math.min(.1, (now - _last) / 1000); _last = now;
  if (playhead >= total()) { playhead = total(); pause(); updHead(); return; }
  syncAt(playhead, true); updHead();
  requestAnimationFrame(tick);
}
function seek(t) { playhead = clamp(t, 0, Math.max(0, total())); syncAt(playhead, false); updHead(); }
