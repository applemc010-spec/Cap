'use strict';
/* ---------------------------------------------------------------- state */
let _tid = 0, _cid = 0, _sid = 0;
const S = {};                                   // media sources: sid -> {sid,path,name,kind,dur,w,h,thumb,url,hasMeta}
let P = { ratio: SET.ratio, tracks: [], clips: [] };
let selId = null, playhead = 0, playing = false, zoom = 80, previewQ = 'orig';
const undoS = [], redoS = [];

const mkTrack = (kind, name) => ({ id: ++_tid, kind, name, mute: false, lock: false, hide: false });
function defaultTracks() {
  const main = mkTrack('video', 'V1'); main.main = true;
  return [mkTrack('text', 'T1'), mkTrack('video', 'V2'), main, mkTrack('audio', 'A1')];
}
P.tracks = defaultTracks();

const trk = id => P.tracks.find(t => t.id === id);
const mainTrack = () => P.tracks.find(t => t.main);
const SEL = () => P.clips.find(c => c.id === selId) || null;
const isMain = c => { const t = trk(c.track); return !!(t && t.main); };
const cEnd = c => c.start + c.dur;
const total = () => P.clips.reduce((a, c) => Math.max(a, cEnd(c)), 0);
const srcSpan = c => c.dur * c.speed;           // seconds of source consumed

/* ---------------------------------------------------------------- clip factory */
const FX0 = () => ({ brightness: 0, contrast: 0, saturation: 0, blur: 0, filter: 'none', flip: false });
const MASK0 = () => ({ on: false, shape: 'rect', x: .3, y: .3, w: .4, h: .3, blur: 25 });
const CHROMA0 = () => ({ on: false, color: '00ff00', sim: .25, blend: .05 });
function baseClip(kind, track, name) {
  return {
    id: ++_cid, kind, track, name, src: 0, start: 0, in: 0, dur: 5, speed: 1,
    vol: 1, aFadeIn: 0, aFadeOut: 0, denoise: false, pitch: 0,
    fx: FX0(), mask: MASK0(), chroma: CHROMA0(),
    x: .5, y: .5, scale: 1, rot: 0, opacity: 1, kf: { x: [], y: [], s: [], r: [], o: [] },
    animIn: 'none', animOut: 'none', animDur: .5, trans: 'none', transDur: .5,
    text: '', style: 'plain', textSize: 7, textColor: '#ffffff', emoji: ''
  };
}

/* ---------------------------------------------------------------- history */
const snapshot = () => JSON.stringify({ tracks: P.tracks, clips: P.clips });
function snap() { undoS.push(snapshot()); if (undoS.length > 150) undoS.shift(); redoS.length = 0; scheduleAutosave(); }
function restore(json) {
  const o = JSON.parse(json); P.tracks = o.tracks; P.clips = o.clips;
  if (!SEL()) selId = null;
  gcRuntime(); refreshAll();
}
function undo() { if (!undoS.length) return; redoS.push(snapshot()); restore(undoS.pop()); }
function redo() { if (!redoS.length) return; undoS.push(snapshot()); restore(redoS.pop()); }
function dropLastSnap() { undoS.pop(); }

/* ---------------------------------------------------------------- tracks */
function addTrack(kind) {
  snap();
  const n = P.tracks.filter(t => t.kind === kind).length + 1;
  const t = mkTrack(kind, kind === 'video' ? 'V' + (n + 1) : kind === 'text' ? 'T' + n : 'A' + n);
  if (kind === 'video') P.tracks.splice(P.tracks.indexOf(mainTrack()), 0, t);
  else if (kind === 'text') P.tracks.unshift(t);
  else P.tracks.push(t);
  refreshAll();
}
function removeTrack(id) {
  const t = trk(id);
  if (!t || t.main) return toast('لا يمكن حذف المسار الأساسي');
  if (P.clips.some(c => c.track === id)) return toast('أفرغ المسار من المقاطع أولاً');
  snap(); P.tracks = P.tracks.filter(x => x.id !== id); refreshAll();
}
function ensureTrack(kind) {
  let t = P.tracks.find(x => x.kind === kind && !x.main && !x.lock);
  if (!t) { addTrackSilent(kind); t = P.tracks.find(x => x.kind === kind && !x.main); }
  return t;
}
function addTrackSilent(kind) {
  const t = mkTrack(kind, kind === 'video' ? 'V2' : kind === 'text' ? 'T1' : 'A1');
  if (kind === 'video') P.tracks.splice(P.tracks.indexOf(mainTrack()), 0, t);
  else if (kind === 'text') P.tracks.unshift(t); else P.tracks.push(t);
}
const accepts = (t, c) => t.kind === 'audio' ? c.kind === 'audio'
  : t.kind === 'text' ? ['text', 'sticker', 'image'].includes(c.kind)
    : t.main ? ['video', 'image'].includes(c.kind) : ['video', 'image'].includes(c.kind);

/* first free start >= want on a track so the clip does not overlap its neighbours */
function placeFree(trackId, want, dur, ignoreId) {
  const cs = P.clips.filter(c => c.track === trackId && c.id !== ignoreId).sort((a, b) => a.start - b.start);
  let s = Math.max(0, want);
  for (const c of cs) { if (s + dur <= c.start + 1e-6) break; if (s < cEnd(c) - 1e-6) s = cEnd(c); }
  return s;
}

/* ---------------------------------------------------------------- keyframes & animation presets */
const CH = { x: 'x', y: 'y', s: 'scale', r: 'rot', o: 'opacity' };
function lerpKf(arr, t) {
  if (t <= arr[0][0]) return arr[0][1];
  for (let i = 1; i < arr.length; i++) if (t < arr[i][0]) {
    const [t0, v0] = arr[i - 1], [t1, v1] = arr[i]; return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
  }
  return arr[arr.length - 1][1];
}
const ANIMS = [['none', 'بدون'], ['fade', 'تلاشي'], ['slideleft', 'انزلاق يسار'], ['slideright', 'انزلاق يمين'],
['slideup', 'انزلاق أعلى'], ['slidedown', 'انزلاق أسفل'], ['zoom', 'تكبير'], ['spin', 'دوران'], ['pop', 'نبضة']];
function animStart(type, b) {
  switch (type) {
    case 'slideleft': return { x: b.x - .6 }; case 'slideright': return { x: b.x + .6 };
    case 'slideup': return { y: b.y - .6 }; case 'slidedown': return { y: b.y + .6 };
    case 'zoom': return { s: b.s * .2 }; case 'spin': return { r: b.r - 180, s: b.s * .3 };
    default: return {};
  }
}
/* effective keyframes = user keyframes, or base value + in/out presets (times are clip-local seconds) */
function effKf(c) {
  const d = clamp(c.animDur || .5, .1, Math.max(.1, c.dur / 2));
  const base = { x: c.x, y: c.y, s: c.scale, r: c.rot, o: c.opacity };
  const si = animStart(c.animIn, base), so = animStart(c.animOut, base), out = {};
  for (const ch of ['x', 'y', 's', 'r', 'o']) {
    if (c.kf[ch].length) { out[ch] = c.kf[ch].map(p => [p[0], p[1]]); continue; }
    const pts = [];
    if (c.animIn === 'pop' && ch === 's') pts.push([0, 0], [d * .7, base.s * 1.15], [d, base.s]);
    else if (ch in si) pts.push([0, si[ch]], [d, base[ch]]);
    else pts.push([0, base[ch]]);
    if (ch in so) pts.push([Math.max(c.dur - d, d + .01), base[ch]], [c.dur, so[ch]]);
    out[ch] = pts;
  }
  out.fadeIn = c.animIn === 'fade' ? d : 0; out.fadeOut = c.animOut === 'fade' ? d : 0;
  return out;
}
function evalP(c, tl) {
  const k = effKf(c);
  let fade = 1;
  if (k.fadeIn > 0) fade = Math.min(fade, clamp(tl / k.fadeIn, 0, 1));
  if (k.fadeOut > 0) fade = Math.min(fade, clamp((c.dur - tl) / k.fadeOut, 0, 1));
  return { x: lerpKf(k.x, tl), y: lerpKf(k.y, tl), s: lerpKf(k.s, tl), r: lerpKf(k.r, tl), o: lerpKf(k.o, tl), fade };
}
/* value shown in the inspector: user keyframes (or base) only, no presets */
const chanVal = (c, ch, tl) => c.kf[ch].length ? lerpKf(c.kf[ch], tl) : c[CH[ch]];
function setChan(c, ch, v, tl) {
  if (c.kf[ch].length) {
    const t = Math.round(clamp(tl, 0, c.dur) * 100) / 100, a = c.kf[ch];
    const hit = a.find(p => Math.abs(p[0] - t) < .03);
    if (hit) hit[1] = v; else { a.push([t, v]); a.sort((p, q) => p[0] - q[0]); }
  } else c[CH[ch]] = v;
}
function toggleKf(c, ch, tl) {
  const a = c.kf[ch], t = Math.round(clamp(tl, 0, c.dur) * 100) / 100;
  const i = a.findIndex(p => Math.abs(p[0] - t) < .03);
  if (i >= 0) { const v = a[i][1]; a.splice(i, 1); if (!a.length) c[CH[ch]] = v; }
  else { const v = chanVal(c, ch, tl); a.push([t, v]); a.sort((p, q) => p[0] - q[0]); }
}

/* ---------------------------------------------------------------- transitions (ripple on the main track) */
function setTrans(a, type, dur) {
  const list = P.clips.filter(c => c.track === a.track).sort((p, q) => p.start - q.start);
  const i = list.indexOf(a), b = list[i + 1];
  if (!b) return false;
  const oldOv = Math.max(0, cEnd(a) - b.start);
  if (Math.abs(b.start - (cEnd(a) - oldOv)) > .05) return false;
  const newOv = type === 'none' ? 0 : Math.min(dur, a.dur / 2, b.dur / 2);
  const delta = newOv - oldOv;
  a.trans = type; a.transDur = dur;
  for (const c of list.slice(i + 1)) c.start -= delta;
  return true;
}

/* ---------------------------------------------------------------- text / sticker bitmaps (browser shapes Arabic correctly) */
const BM = new Map();
const FONT = '"Segoe UI","Noto Sans Arabic",Tahoma,sans-serif';
function bitmap(c, H) {
  const key = [c.kind, c.text, c.emoji, c.style, c.textSize, c.textColor, H].join('|');
  let b = BM.get(key); if (b) return b;
  const cv = document.createElement('canvas'), x = cv.getContext('2d');
  const fs = Math.max(8, c.textSize / 100 * H);
  if (c.kind === 'sticker') {
    const s = Math.ceil(fs * 1.4); cv.width = cv.height = s;
    x.font = `${fs}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(c.emoji || '⭐', s / 2, s / 2 * 1.04);
  } else {
    const font = `700 ${fs}px ${FONT}`, lines = (c.text || ' ').split('\n');
    x.font = font;
    const w = Math.ceil(Math.max(...lines.map(l => x.measureText(l).width))), pad = Math.ceil(fs * .5), lh = fs * 1.3;
    cv.width = Math.max(4, w + pad * 2); cv.height = Math.max(4, Math.ceil(lines.length * lh + pad * 2));
    x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
    x.direction = /[\u0600-\u06FF]/.test(c.text) ? 'rtl' : 'ltr';
    if (c.style === 'box') {
      x.fillStyle = 'rgba(0,0,0,.68)'; x.beginPath();
      (x.roundRect ? x.roundRect(pad * .3, pad * .3, cv.width - pad * .6, cv.height - pad * .6, fs * .35) : x.rect(0, 0, cv.width, cv.height));
      x.fill();
    }
    lines.forEach((ln, i) => {
      const y = pad + lh * (i + .5), cx = cv.width / 2;
      x.save();
      if (c.style === 'outline') { x.lineWidth = fs * .16; x.strokeStyle = 'rgba(0,0,0,.92)'; x.strokeText(ln, cx, y); }
      if (c.style === 'neon') { x.shadowColor = c.textColor; x.shadowBlur = fs * .6; x.fillStyle = c.textColor; x.fillText(ln, cx, y); x.fillText(ln, cx, y); }
      if (c.style === 'plain') { x.shadowColor = 'rgba(0,0,0,.65)'; x.shadowBlur = fs * .18; x.shadowOffsetY = fs * .04; }
      x.fillStyle = c.style === 'neon' ? '#ffffff' : c.textColor; x.fillText(ln, cx, y);
      x.restore();
    });
  }
  b = { url: cv.toDataURL('image/png'), w: cv.width, h: cv.height };
  if (BM.size > 240) BM.clear();
  BM.set(key, b); return b;
}

/* ---------------------------------------------------------------- autosave */
let _as = null;
function scheduleAutosave() {
  if (!SET.autosave || !TA) return;
  clearTimeout(_as); _as = setTimeout(() => invoke('autosave', { text: projectJSON() }).catch(() => { }), 1200);
}
function projectJSON() {
  return JSON.stringify({
    v: 2, ratio: P.ratio, tracks: P.tracks, clips: P.clips,
    sources: Object.values(S).map(s => ({ sid: s.sid, path: s.path, name: s.name, kind: s.kind }))
  });
}
