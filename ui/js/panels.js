'use strict';
/* ---------------------------------------------------------------- media import */
async function pickFiles(kinds) {
  if (!TA) return toast('شغّل البرنامج المثبّت (وليس من المتصفح)');
  const exts = { video: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mts'], image: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'], audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma'] };
  const filters = kinds.map(k => ({ name: k, extensions: exts[k] }));
  const r = await TA.dialog.open({ multiple: true, filters });
  if (r) importPaths(Array.isArray(r) ? r : [r]);
}
async function importPaths(paths) {
  for (const p of paths) {
    const k = kindOfPath(p); if (!k) continue;
    try { const s = await loadSource(p, k); addSourceClip(s, k === 'audio' ? 'audio' : 'main'); }
    catch (e) { toast('تعذر فتح الملف: ' + p.split(/[\\/]/).pop(), 5000); }
  }
}
const proxyHeight = () => previewQ === 'orig' ? 720 : +previewQ;
async function loadSource(path, kind, info) {
  const sid = (info && info.sid) || ++_sid; _sid = Math.max(_sid, sid);
  const s = { sid, path, name: path.split(/[\\/]/).pop(), kind, dur: 0, w: 0, h: 0, thumb: '', url: asset(path), forceProxy: false };
  S[sid] = s;
  try {
    if (kind === 'image') {
      await new Promise((res, rej) => { const im = new Image(); im.onload = () => { s.w = im.naturalWidth; s.h = im.naturalHeight; res(); }; im.onerror = rej; im.src = s.url; });
      s.thumb = s.url; s.dur = 5;
    } else if (kind === 'audio') {
      const pr = await invoke('probe', { path }); s.dur = pr[0] || 0; if (!s.dur) throw new Error('dur');
    } else {
      const probeVideo = src => new Promise((res, rej) => {
        const v = document.createElement('video'); v.preload = 'metadata';
        v.onloadedmetadata = () => { s.w = v.videoWidth; s.h = v.videoHeight; s.dur = v.duration; res(); }; v.onerror = () => rej(new Error('load')); v.src = src;
      });
      try { await probeVideo(s.url); }
      catch (_) { toast('جاري تجهيز نسخة معاينة للملف…', 6000); s.forceProxy = true; s.url = asset(await invoke('make_proxy', { path, height: 720 })); await probeVideo(s.url); }
      const big = Math.max(s.w, s.h) > 1920;
      if (!s.forceProxy && (previewQ !== 'orig' || (SET.autoproxy && big))) {
        s.forceProxy = previewQ === 'orig'; s.url = asset(await invoke('make_proxy', { path, height: proxyHeight() }));
      }
      try { const th = await invoke('make_thumb', { path }); if (th) s.thumb = asset(th); } catch (_) { }
    }
  } catch (e) { delete S[sid]; throw e; }
  renderPool();
  return s;
}
function addSourceClip(s, mode) {
  snap();
  const c = baseClip(s.kind, 0, s.name); c.src = s.sid;
  if (s.kind === 'audio') {
    c.track = ensureTrack('audio').id; c.dur = s.dur; c.start = placeFree(c.track, playhead, c.dur);
  } else {
    c.dur = s.kind === 'image' ? 5 : s.dur;
    if (mode === 'main') {
      c.track = mainTrack().id;
      const last = P.clips.filter(x => x.track === c.track).reduce((a, x) => Math.max(a, cEnd(x)), 0);
      c.start = last;
    } else {
      c.track = ensureTrack('video').id; c.start = placeFree(c.track, playhead, c.dur);
      c.scale = .5; c.x = .72; c.y = .3;
    }
  }
  P.clips.push(c); selId = c.id; refreshAll();
}
function renderPool() {
  const p = $('#pool'); p.innerHTML = '';
  Object.values(S).forEach(s => {
    const d = document.createElement('div'); d.className = 'card';
    d.innerHTML = `${s.thumb ? `<img src="${s.thumb}">` : `<div class="ph">${s.kind === 'audio' ? '🎵' : ''}</div>`}
      <div class="nm">${esc(s.name)}<div class="val">${s.kind === 'image' ? 'صورة' : fmt(s.dur)}</div></div>
      <button class="btn" data-m="main" title="إضافة للمسار الأساسي">＋</button>${s.kind === 'audio' ? '' : '<button class="btn" data-m="over" title="إضافة كطبقة علوية (PIP)">▲</button>'}`;
    d.querySelectorAll('button').forEach(b => b.onclick = () => addSourceClip(s, b.dataset.m));
    p.appendChild(d);
  });
}
async function applyQuality() {
  toast('جاري تغيير جودة المعاينة…', 9000);
  try {
    for (const s of Object.values(S)) {
      if (s.kind !== 'video') continue;
      s.url = (previewQ === 'orig' && !s.forceProxy) ? asset(s.path) : asset(await invoke('make_proxy', { path: s.path, height: proxyHeight() }));
    }
    retargetSources(); toast('تم');
  } catch (e) { toast('فشل: ' + e, 6000); }
}

/* ---------------------------------------------------------------- library: effects, transitions, text, stickers */
const FX = [['none', 'بدون', '⭕', 1], ['bw', 'أبيض وأسود', '⚫', 1], ['sepia', 'قديم', '📜', 1], ['warm', 'دافئ', '🔥', 1], ['cool', 'بارد', '❄️', 1], ['negative', 'سالب', '🎞️', 1],
['vignette', 'تظليل الحواف', '◐', 1], ['sharpen', 'حدّة', '🔺', 0], ['rgbsplit', 'RGB Split', '🌈', 0], ['glitch', 'Glitch', '⚡', 0], ['vhs', 'VHS', '📼', 0], ['grain', 'حبيبات فيلم', '🎬', 0],
['shake', 'اهتزاز الكاميرا', '📳', 0], ['pixelate', 'بكسلة', '🔳', 0]];
const TR = [['none', 'بدون', '—'], ['fade', 'تلاشي', '🌫️'], ['dissolve', 'ذوبان', '💧'], ['fadeblack', 'تلاشي للأسود', '⬛'], ['wipeleft', 'مسح يسار', '◀'], ['wiperight', 'مسح يمين', '▶'],
['slideleft', 'انزلاق يسار', '⏪'], ['slideright', 'انزلاق يمين', '⏩'], ['circleopen', 'دائرة تفتح', '⭕'], ['circleclose', 'دائرة تغلق', '🔘'], ['pixelize', 'بكسلة', '🔳'],
['radial', 'دوران', '🌀'], ['zoomin', 'تقريب', '🔍'], ['smoothleft', 'نعومة', '〰️']];
const STICKERS = {
  'رائج': ['🔔', '👍', '❤️', '🔥', '⭐', '✅', '📢', '➕', '🎯', '💯', '👑', '🚀'],
  'وجوه': ['😀', '😂', '🥹', '😍', '😎', '🤩', '😭', '😡', '🥳', '🤯', '😴', '🤔'],
  'رسم': ['➡️', '⬅️', '⬆️', '⬇️', '↗️', '❓', '❗', '💬', '💭', '⭕', '✔️', '✖️'],
  'يوميات': ['✈️', '🍔', '☕', '🌴', '📍', '📷', '🎵', '☀️', '🌧️', '🏖️', '🛍️', '🚗'],
  'جماليات': ['✨', '💫', '🌟', '💖', '🌸', '🦋', '🌈', '🎀', '🪩', '💎', '🫧', '🍀']
};
const TEXT_TPL = [['plain', 'عادي', '#ffffff'], ['outline', 'حدود', '#ffe14d'], ['neon', 'نيون', '#38f2ff'], ['box', 'صندوق', '#ffffff']];

function buildGrid(el, list, onPick, activeFn) {
  el.innerHTML = list.map(([k, n, i, pv]) => `<div class="tile" data-k="${k}"><span>${i}</span>${n}${pv === 0 ? '<em title="يظهر في التصدير فقط">★</em>' : ''}</div>`).join('');
  el.querySelectorAll('.tile').forEach(t => t.onclick = () => onPick(t.dataset.k));
  el._active = activeFn;
}
function markGrids() {
  const c = SEL();
  [['#fxgrid', c && c.fx.filter], ['#trgrid', c && c.trans]].forEach(([s, v]) =>
    $$(s + ' .tile').forEach(t => t.classList.toggle('on', !!c && t.dataset.k === v)));
}
function pickFx(k) {
  const c = SEL(); if (!c || c.kind !== 'video') return toast('اختر مقطع فيديو أولاً');
  snap(); c.fx.filter = k; refreshAll();
}
function addTextClip(style, color, text) {
  snap();
  const c = baseClip('text', ensureTrack('text').id, 'نص'); c.text = text || 'نص جديد'; c.style = style || 'outline'; c.textColor = color || '#ffffff';
  c.y = .82; c.start = placeFree(c.track, playhead, c.dur); P.clips.push(c); selId = c.id; refreshAll();
}
function addSticker(e) {
  snap();
  const c = baseClip('sticker', ensureTrack('text').id, 'ملصق'); c.emoji = e; c.textSize = 18;
  c.start = placeFree(c.track, playhead, c.dur); P.clips.push(c); selId = c.id; refreshAll();
}
function buildLibrary() {
  buildGrid($('#fxgrid'), FX, pickFx);
  buildGrid($('#trgrid'), TR, k => applyTrans(k));
  $('#tpl').innerHTML = TEXT_TPL.map(([k, n, col]) => `<button class="btn tpl" data-k="${k}" data-c="${col}" style="color:${col}">${n}</button>`).join('');
  $$('#tpl .tpl').forEach(b => b.onclick = () => addTextClip(b.dataset.k, b.dataset.c));
  $('#stk').innerHTML = Object.entries(STICKERS).map(([g, a]) => `<h4>${g}</h4><div class="emo">${a.map(e => `<button data-e="${e}">${e}</button>`).join('')}</div>`).join('');
  $$('#stk button').forEach(b => b.onclick = () => addSticker(b.dataset.e));
  $$('#tabs button').forEach(b => b.onclick = () => {
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.pane').forEach(p => p.classList.toggle('on', p.id === 'p-' + b.dataset.t));
  });
}

/* ---------------------------------------------------------------- auto captions (whisper.cpp, offline) */
async function autoCaptions() {
  const c = SEL();
  if (!c || !isMedia(c)) return toast('اختر مقطع فيديو أو صوت أولاً');
  if (!TA) return;
  if (!(await invoke('captions_ready'))) return toast('محرك التفريغ غير مثبّت: ضع whisper-cli.exe وملف ggml-base.bin في مجلد bin\\whisper', 9000);
  const btn = $('#capBtn'); btn.disabled = true; btn.textContent = 'جاري التفريغ… (قد يستغرق دقائق)';
  try {
    const segs = await invoke('transcribe', { path: S[c.src].path, inn: c.in, dur: srcSpan(c), lang: $('#capLang').value });
    if (!segs.length) toast('لم يتم العثور على كلام');
    else {
      snap();
      const tr = ensureTrack('text');
      for (const s of segs) {
        const t = baseClip('text', tr.id, 'ترجمة'); t.text = s.text; t.style = 'outline'; t.textSize = 5.5; t.y = .88;
        t.start = c.start + s.start / c.speed; t.dur = Math.max(.3, (s.end - s.start) / c.speed);
        const free = placeFree(tr.id, t.start, t.dur); if (Math.abs(free - t.start) > .001) t.start = free;
        P.clips.push(t);
      }
      refreshAll(); toast(`تمت إضافة ${segs.length} سطر ترجمة`);
    }
  } catch (e) { toast('فشل التفريغ: ' + e, 9000); }
  btn.disabled = false; btn.textContent = '✨ ترجمة تلقائية للمقطع المحدد';
}

/* ---------------------------------------------------------------- inspector */
const KFROWS = [['x', 'الموضع X', 0, 1, .005], ['y', 'الموضع Y', 0, 1, .005], ['s', 'الحجم', .05, 4, .01], ['r', 'الدوران', -180, 180, 1], ['o', 'الشفافية', 0, 1, .01]];
function buildInspector() {
  $('#kfrows').innerHTML = KFROWS.map(([ch, n, mn, mx, st]) =>
    `<div class="kfrow" data-ch="${ch}"><label>${n}</label><input type="range" min="${mn}" max="${mx}" step="${st}"><button class="dia" title="إضافة / إزالة إطار مفتاحي عند المؤشر">◆</button></div>`).join('');
  $$('#kfrows .kfrow').forEach(row => {
    const ch = row.dataset.ch, inp = row.querySelector('input'), dia = row.querySelector('.dia');
    inp.addEventListener('pointerdown', snap);
    inp.addEventListener('input', () => {
      const c = SEL(); if (!c) return;
      setChan(c, ch, +inp.value, clamp(playhead - c.start, 0, c.dur)); syncAt(playhead, false); renderTimeline();
    });
    dia.addEventListener('click', () => {
      const c = SEL(); if (!c) return; snap();
      toggleKf(c, ch, clamp(playhead - c.start, 0, c.dur)); refreshAll();
    });
  });
  $('#animIn').innerHTML = $('#animOut').innerHTML = ANIMS.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  $('#transSel').innerHTML = TR.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  $$('.itab').forEach(b => b.onclick = () => {
    $$('.itab').forEach(x => x.classList.toggle('on', x === b));
    $$('.ipane').forEach(p => p.classList.toggle('on', p.id === 'i-' + b.dataset.t));
  });
}
const getP = (o, p) => p.split('.').reduce((a, k) => a && a[k], o);
const setP = (o, p, v) => { const k = p.split('.'), l = k.pop(); k.reduce((a, x) => a[x], o)[l] = v; };
function bindInputs() {
  $$('[data-p]').forEach(el => {
    const instant = el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'color';
    if (el.type === 'range') { el.addEventListener('pointerdown', snap); el.addEventListener('pointerup', () => el.blur()); }
    else if (!instant) el.addEventListener('focus', snap);
    el.addEventListener(instant ? 'change' : 'input', () => {
      const c = SEL(); if (!c) return;
      if (instant) snap();
      const v = el.type === 'checkbox' ? el.checked : (el.dataset.num ? +el.value : el.value);
      const p = el.dataset.p;
      if (p === 'speed') setSpeed(c, v);
      else if (p === 'transSel') applyTrans(v);
      else if (p === 'dur') c.dur = Math.max(.1, v);
      else setP(c, p, p === 'chroma.color' ? String(v).replace('#', '') : v);
      refreshAll();
    });
  });
}
function applyVisibility(c) {
  $$('[data-k]').forEach(el => {
    const kinds = el.dataset.k.split(','), main = c && isMain(c);
    let show = !!c && kinds.includes(c.kind);
    if (show && el.dataset.ov && main) show = false;           // overlay-only controls
    if (show && el.dataset.main && !main) show = false;        // main-track-only controls
    el.classList.toggle('hid', !show);
  });
}
function refreshInspector() {
  const c = SEL();
  $('#selname').textContent = c ? `${c.name || c.kind}  ·  ${trk(c.track).name}` : 'اختر مقطعاً لعرض خصائصه';
  applyVisibility(c);
  $$('[data-p]').forEach(el => {
    el.disabled = !c; if (!c) return;
    const p = el.dataset.p;
    let v = p === 'chroma.color' ? '#' + c.chroma.color : p === 'transSel' ? c.trans : getP(c, p);
    if (el.type === 'checkbox') el.checked = !!v; else if (v !== undefined && String(v) !== el.value) el.value = v;
  });
  $('#tdv').textContent = c ? c.transDur.toFixed(1) + 's' : '';
  $('#animDurV').textContent = c ? c.animDur.toFixed(1) + 's' : '';
  refreshKfUI(); markGrids();
}
function refreshKfUI() {
  const c = SEL(); if (!c) return;
  const tl = clamp(playhead - c.start, 0, c.dur);
  $$('#kfrows .kfrow').forEach(row => {
    const ch = row.dataset.ch, inp = row.querySelector('input'), dia = row.querySelector('.dia');
    if (document.activeElement !== inp) inp.value = chanVal(c, ch, tl);
    dia.classList.toggle('has', c.kf[ch].length > 0);
    dia.classList.toggle('on', c.kf[ch].some(p => Math.abs(p[0] - tl) < .03));
  });
}
function refreshAll() {
  gcRuntime(); renderTimeline(); renderPool(); refreshInspector();
  fitFrame(); syncAt(viewT, false);
}
