'use strict';
const TH = 96;                                   // track header width (px)
const scrollEl = $('#scroll'), inner = $('#inner'), rowsEl = $('#rows');
const isMedia = c => c.kind === 'video' || c.kind === 'audio';

/* ---------------------------------------------------------------- rendering */
function renderTimeline() {
  const T = total();
  inner.style.width = (TH + Math.max(T * zoom + 400, scrollEl.clientWidth - TH)) + 'px';
  const step = zoom >= 150 ? 1 : zoom >= 60 ? 2 : zoom >= 30 ? 5 : 10;
  let r = '';
  for (let s = 0; s <= Math.ceil(T) + 6; s += step) r += `<span style="left:${s * zoom}px">${s}s</span>`;
  $('#rl').innerHTML = r;

  rowsEl.innerHTML = '';
  for (const t of P.tracks) {
    const row = document.createElement('div'); row.className = 'trk k-' + t.kind + (t.main ? ' main' : '');
    row.innerHTML = `<div class="th"><b>${esc(t.name)}${t.main ? ' ★' : ''}</b>
      <span><button data-a="hide" data-t="${t.id}" title="إخفاء" class="${t.hide ? 'off' : ''}">👁</button><button data-a="mute" data-t="${t.id}" title="كتم" class="${t.mute ? 'off' : ''}">🔊</button><button data-a="lock" data-t="${t.id}" title="قفل" class="${t.lock ? 'off' : ''}">🔒</button>${t.main ? '' : `<button data-a="del" data-t="${t.id}" title="حذف المسار">✕</button>`}</span></div>
      <div class="lane" data-track="${t.id}"></div>`;
    const lane = row.querySelector('.lane');
    for (const c of P.clips) if (c.track === t.id) lane.appendChild(clipEl(c, t));
    rowsEl.appendChild(row);
  }
  updHead();
}
function clipEl(c, t) {
  const d = document.createElement('div');
  d.className = 'clip k-' + c.kind + (c.id === selId ? ' sel' : '') + (t.lock ? ' locked' : '');
  d.dataset.id = c.id; d.style.left = c.start * zoom + 'px'; d.style.width = Math.max(6, c.dur * zoom) + 'px';
  const s = S[c.src];
  if (s && s.thumb && (c.kind === 'video' || c.kind === 'image'))
    d.style.backgroundImage = `linear-gradient(var(--clipov),var(--clipov)),url("${s.thumb}")`;
  const label = c.kind === 'text' ? c.text : c.kind === 'sticker' ? c.emoji : c.name;
  const tags = [c.speed !== 1 ? c.speed + 'x' : '', c.mask.on ? '◧' : '', c.fx.filter !== 'none' || c.fx.blur ? 'fx' : '', c.chroma.on ? '🟩' : ''].filter(Boolean).join(' ');
  d.innerHTML = `<b class="hl"></b><span class="cn">${esc(label || '')}<small>${tags}</small></span><b class="hr"></b>`;
  const times = new Set(); for (const ch of ['x', 'y', 's', 'r', 'o']) c.kf[ch].forEach(p => times.add(p[0]));
  times.forEach(tm => d.insertAdjacentHTML('beforeend', `<i class="kd" style="left:${tm * zoom}px"></i>`));
  if (t.main && c.trans !== 'none') d.insertAdjacentHTML('beforeend', '<i class="tr">⇄</i>');
  return d;
}
function updHead() {
  $('#ph').style.left = (TH + playhead * zoom) + 'px';
  $('#time').textContent = fmt(playhead) + ' / ' + fmt(total());
  if (playing) {
    const x = TH + playhead * zoom;
    if (x > scrollEl.scrollLeft + scrollEl.clientWidth - 40 || x < scrollEl.scrollLeft + TH) scrollEl.scrollLeft = Math.max(0, x - TH - 60);
  }
  if (typeof refreshKfUI === 'function') refreshKfUI();
}
function selectClip(id) {
  selId = id; renderTimeline(); refreshInspector(); syncAt(viewT, false);
}

/* ---------------------------------------------------------------- time <-> pixels, snapping */
function laneLeft() { const l = rowsEl.querySelector('.lane'); return l ? l.getBoundingClientRect().left : 0; }
const timeAt = e => Math.max(0, (e.clientX - laneLeft()) / zoom);
function snapTo(v, thr, skipId) {
  let best = v, bd = thr;
  const pts = [0, playhead];
  for (const o of P.clips) if (o.id !== skipId) pts.push(o.start, cEnd(o));
  for (const p of pts) { const d = Math.abs(p - v); if (d < bd) { bd = d; best = p; } }
  return best;
}

/* ---------------------------------------------------------------- dragging clips */
let CD = null;
const allowedOv = (a, b) => {
  if (!isMain(a)) return false;
  const [p, q] = a.start <= b.start ? [a, b] : [b, a];
  return p.trans !== 'none' && cEnd(p) - q.start <= p.transDur + .05;
};
const overlapsAny = c => P.clips.some(o => o.id !== c.id && o.track === c.track &&
  c.start < cEnd(o) - .02 && o.start < cEnd(c) - .02 && !allowedOv(c, o));

rowsEl.addEventListener('pointerdown', e => {
  const ce = e.target.closest('.clip');
  if (!ce) {
    if (e.target.classList.contains('lane')) { scrubStart(e); }
    return;
  }
  const c = clipById(+ce.dataset.id); if (!c) return;
  if (c.id !== selId) { selId = c.id; refreshInspector(); }
  if (trk(c.track).lock) { renderTimeline(); return; }
  const mode = e.target.classList.contains('hl') ? 'trimL' : e.target.classList.contains('hr') ? 'trimR' : 'move';
  snap();
  CD = { mode, id: c.id, sx: e.clientX, sy: e.clientY, moved: false, o: { start: c.start, in: c.in, dur: c.dur, track: c.track } };
  addEventListener('pointermove', onClipMove); addEventListener('pointerup', endClipDrag, { once: true });
  e.preventDefault();
});
function onClipMove(e) {
  if (!CD) return;
  const c = clipById(CD.id), o = CD.o;
  if (Math.abs(e.clientX - CD.sx) + Math.abs(e.clientY - CD.sy) > 3) CD.moved = true;
  if (!CD.moved) return;
  const dx = (e.clientX - CD.sx) / zoom, thr = 8 / zoom;
  if (CD.mode === 'move') {
    let s = Math.max(0, o.start + dx);
    const a = snapTo(s, thr, c.id), b = snapTo(s + c.dur, thr, c.id) - c.dur;
    s = Math.abs(a - s) <= Math.abs(b - s) ? a : b;
    c.start = Math.max(0, s);
    const lane = document.elementsFromPoint(e.clientX, e.clientY).find(x => x.classList && x.classList.contains('lane'));
    if (lane) { const tt = trk(+lane.dataset.track); if (tt && !tt.lock && accepts(tt, c)) c.track = tt.id; }
  } else if (CD.mode === 'trimL') {
    let dd = clamp(dx, -o.start, o.dur - .1);
    if (isMedia(c)) dd = Math.max(dd, -o.in / c.speed);
    dd = snapTo(o.start + dd, thr, c.id) - o.start;
    dd = clamp(dd, -o.start, o.dur - .1); if (isMedia(c)) dd = Math.max(dd, -o.in / c.speed);
    c.start = o.start + dd; c.dur = o.dur - dd; if (isMedia(c)) c.in = o.in + dd * c.speed;
  } else {
    let nd = Math.max(.1, o.dur + dx);
    nd = snapTo(o.start + nd, thr, c.id) - o.start;
    if (isMedia(c) && S[c.src]) nd = Math.min(nd, (S[c.src].dur - c.in) / c.speed);
    c.dur = Math.max(.1, nd);
  }
  renderTimeline(); syncAt(viewT, false);
}
function endClipDrag() {
  removeEventListener('pointermove', onClipMove);
  if (!CD) return;
  const c = clipById(CD.id);
  if (!CD.moved) dropLastSnap();
  else if (c && overlapsAny(c)) {
    Object.assign(c, CD.o); dropLastSnap(); toast('يوجد تداخل مع مقطع آخر — أُعيد المقطع لمكانه');
  }
  CD = null; refreshAll();
}

/* ---------------------------------------------------------------- scrubbing, hover preview */
let scrub = false;
function scrubStart(e) {
  if (!P.clips.length) return;
  if (playing) pause();
  scrub = true; seek(timeAt(e));
  addEventListener('pointermove', scrubMove);
  addEventListener('pointerup', () => { scrub = false; removeEventListener('pointermove', scrubMove); }, { once: true });
}
const scrubMove = e => { if (scrub) seek(timeAt(e)); };
$('#ruler').addEventListener('pointerdown', scrubStart);

rowsEl.addEventListener('mousemove', e => {                 // hover preview: show the frame under the cursor
  if (playing || CD || scrub || !P.clips.length) return;
  if (!e.target.closest('.lane')) return;
  const t = timeAt(e);
  const hv = $('#hv'); hv.style.display = 'block'; hv.style.left = (TH + t * zoom) + 'px'; $('#tip').textContent = fmt(t);
  syncAt(t, false);
});
rowsEl.addEventListener('mouseleave', () => { $('#hv').style.display = 'none'; if (!playing && !CD) syncAt(playhead, false); });

/* header buttons */
rowsEl.addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const t = trk(+b.dataset.t), a = b.dataset.a;
  if (a === 'del') return removeTrack(t.id);
  snap(); t[a] = !t[a]; refreshAll();
});
scrollEl.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault(); zoom = clamp(zoom * (e.deltaY < 0 ? 1.15 : .87), 15, 400); $('#zoom').value = zoom; renderTimeline();
}, { passive: false });

/* ---------------------------------------------------------------- editing commands */
function splitKf(arr, ts) {
  if (!arr.length) return [[], []];
  const v = lerpKf(arr, ts);
  const left = arr.filter(p => p[0] < ts - .01).map(p => [p[0], p[1]]); left.push([ts, v]);
  const right = [[0, v]].concat(arr.filter(p => p[0] > ts + .01).map(p => [p[0] - ts, p[1]]));
  return [left, right];
}
function splitClip() {
  let c = SEL();
  if (!c || !(playhead > c.start + .1 && playhead < cEnd(c) - .1)) {
    c = null;
    for (const t of P.tracks) {
      if (t.lock) continue;
      c = P.clips.find(x => x.track === t.id && playhead > x.start + .1 && playhead < cEnd(x) - .1);
      if (c) break;
    }
  }
  if (!c) return toast('ضع المؤشر داخل مقطع بعيداً عن حوافه');
  snap();
  const ts = playhead - c.start, b = JSON.parse(JSON.stringify(c));
  b.id = ++_cid; b.start = playhead; b.dur = c.dur - ts;
  if (isMedia(c)) b.in = c.in + ts * c.speed;
  for (const ch of ['x', 'y', 's', 'r', 'o']) { const [l, r] = splitKf(c.kf[ch], ts); c.kf[ch] = l; b.kf[ch] = r; }
  b.trans = c.trans; c.trans = 'none'; c.animOut = 'none'; b.animIn = 'none';
  c.dur = ts; P.clips.push(b); selId = b.id; refreshAll();
}
function dupClip() {
  const c = SEL(); if (!c) return;
  snap();
  const b = JSON.parse(JSON.stringify(c)); b.id = ++_cid; b.trans = 'none';
  b.start = placeFree(c.track, cEnd(c), c.dur); selId = b.id; P.clips.push(b); refreshAll();
}
function delClip(ripple) {
  const c = SEL(); if (!c) return;
  snap();
  P.clips = P.clips.filter(x => x.id !== c.id);
  if (ripple) for (const o of P.clips) if (o.track === c.track && o.start >= cEnd(c) - .02) o.start = Math.max(0, o.start - c.dur);
  selId = null; gcRuntime(); refreshAll();
}
function bumpSpeed(dir) {
  const c = SEL(); if (!c || !isMedia(c)) return;
  let j = LADDER.reduce((b, x, i) => Math.abs(x - c.speed) < Math.abs(LADDER[b] - c.speed) ? i : b, 0);
  j = clamp(j + dir, 0, LADDER.length - 1);
  snap(); setSpeed(c, LADDER[j]); refreshAll(); toast('السرعة ' + c.speed + 'x', 900);
}
function setSpeed(c, sp) {                       // keeps the same source span, changes the timeline length
  const span = srcSpan(c); c.speed = sp; c.dur = Math.max(.1, span / sp);
  if (S[c.src] && S[c.src].dur) c.dur = Math.min(c.dur, (S[c.src].dur - c.in) / sp);
  if (isMain(c)) { /* clips after it keep their start; gaps / overlaps are resolved by the user */ }
}
function applyTrans(type) {
  const c = SEL(); if (!c) return toast('اختر مقطعاً من المسار الأساسي أولاً');
  if (!isMain(c)) return toast('الانتقالات متاحة على المسار الأساسي V1');
  snap();
  if (!setTrans(c, type, c.transDur)) { dropLastSnap(); return toast('لا يوجد مقطع متلاصق بعده لتطبيق الانتقال'); }
  refreshAll();
}
