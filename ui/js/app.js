'use strict';
/* ---------------------------------------------------------------- export job (what the Rust backend receives) */
function dims(short) {
  const [a, b] = P.ratio.split(':').map(Number), ev = x => Math.round(x / 2) * 2;
  return a >= b ? { W: ev(short * a / b), H: short } : { W: short, H: ev(short * b / a) };
}
const roundKf = a => a.map(p => [Math.round(p[0] * 1000) / 1000, p[1]]);
function buildJob(o) {
  const { W, H } = dims(o.res);
  const layers = [], audios = [];
  for (const t of [...P.tracks].reverse()) {                       // bottom track first = lowest layer
    if (t.kind === 'audio') {
      for (const c of P.clips.filter(x => x.track === t.id).sort((a, b) => a.start - b.start))
        audios.push({
          path: S[c.src].path, start: c.start, dur: c.dur, inn: c.in, speed: c.speed,
          audio: { vol: c.vol, fadeIn: c.aFadeIn, fadeOut: c.aFadeOut, denoise: c.denoise, pitch: c.pitch, mute: t.mute }
        });
      continue;
    }
    if (t.hide) continue;
    for (const c of P.clips.filter(x => x.track === t.id).sort((a, b) => a.start - b.start)) {
      const main = !!t.main, k = effKf(c);
      const tf = main ? { x: [[0, .5]], y: [[0, .5]], s: [[0, 1]], r: [[0, 0]], o: [[0, 1]] }
        : { x: roundKf(k.x), y: roundKf(k.y), s: roundKf(k.s), r: roundKf(k.r), o: roundKf(k.o) };
      const L = {
        kind: c.kind === 'text' || c.kind === 'sticker' ? 'png' : c.kind, main, path: c.src ? S[c.src].path : '', png: null,
        start: c.start, dur: c.dur, inn: c.in, speed: c.kind === 'video' ? c.speed : 1,
        fx: c.fx, mask: c.mask, chroma: main ? null : c.chroma, tf,
        fadeIn: main ? 0 : k.fadeIn, fadeOut: main ? 0 : k.fadeOut, trans: c.trans, audio: null
      };
      if (L.kind === 'png') L.png = bitmap(c, H).url;
      if (c.kind === 'video') L.audio = { vol: c.vol, fadeIn: c.aFadeIn, fadeOut: c.aFadeOut, denoise: c.denoise, pitch: c.pitch, mute: t.mute };
      layers.push(L);
    }
  }
  return {
    w: W, h: H, fps: o.fps, duration: total(), layers, audios, container: o.container, codec: o.codec,
    rateMode: o.rateMode, crf: o.crf, bitrateMbps: o.bitrate, preset: o.preset, output: o.output
  };
}
const xval = id => $('#' + id).value;
function showDims() {
  const d = dims(+xval('xres')); $('#xdim').textContent = d.W + ' × ' + d.H;
  $('#xcrfw').style.display = xval('xmode') === 'crf' ? '' : 'none';
  $('#xbrw').style.display = xval('xmode') === 'bitrate' ? '' : 'none';
}
async function doExport() {
  const container = xval('xcont');
  const out = await TA.dialog.save({ filters: [{ name: container.toUpperCase(), extensions: [container] }], defaultPath: 'video.' + container });
  if (!out) return;
  const job = buildJob({
    res: +xval('xres'), fps: +xval('xfps'), container, codec: xval('xcodec'), rateMode: xval('xmode'),
    crf: +xval('xq'), bitrate: +xval('xbr') || 20, preset: xval('xpreset'), output: out
  });
  if (!job.layers.length && !job.audios.length) return toast('لا يوجد شيء للتصدير');
  $('#xgo').disabled = true; $('#bar').style.display = 'block'; $('#bar i').style.width = '0';
  $('#xmsg').style.whiteSpace = 'normal'; $('#xmsg').textContent = 'جاري التصدير… لا تغلق البرنامج';
  try { const p = await invoke('export_video', { job }); $('#xmsg').textContent = '✔ تم التصدير: ' + p; }
  catch (e) { $('#xmsg').style.whiteSpace = 'pre-wrap'; $('#xmsg').textContent = '✖ فشل التصدير:\n' + e; }
  $('#xgo').disabled = false;
}

/* ---------------------------------------------------------------- projects */
async function newProject() {
  if (P.clips.length && !confirm('مشروع جديد؟ سيتم تجاهل التغييرات غير المحفوظة.')) return;
  pause(); resetRuntime(); for (const k in S) delete S[k];
  P.tracks = defaultTracks(); P.clips = []; selId = null; playhead = 0; undoS.length = redoS.length = 0;
  refreshAll();
}
async function saveProject() {
  const p = await TA.dialog.save({ filters: [{ name: 'RustCut', extensions: ['rustcut'] }], defaultPath: 'project.rustcut' });
  if (!p) return;
  try { await invoke('write_text', { path: p, text: projectJSON() }); toast('تم حفظ المشروع'); } catch (e) { toast('فشل الحفظ: ' + e, 6000); }
}
async function openProject() {
  const p = await TA.dialog.open({ multiple: false, filters: [{ name: 'RustCut', extensions: ['rustcut'] }] });
  if (p) loadProjectText(await invoke('read_text', { path: Array.isArray(p) ? p[0] : p }));
}
async function loadProjectText(text) {
  let o; try { o = JSON.parse(text); } catch (_) { return toast('ملف المشروع تالف'); }
  pause(); resetRuntime(); for (const k in S) delete S[k];
  const missing = [];
  for (const s of o.sources || []) { try { await loadSource(s.path, s.kind, { sid: s.sid }); } catch (_) { missing.push(s.name); } }
  P.ratio = o.ratio || '16:9'; P.tracks = o.tracks; P.clips = o.clips.filter(c => !c.src || S[c.src]);
  _tid = Math.max(0, ...P.tracks.map(t => t.id)); _cid = Math.max(0, ...P.clips.map(c => c.id));
  $('#ratio').value = P.ratio; selId = null; playhead = 0; undoS.length = redoS.length = 0;
  refreshAll();
  if (missing.length) toast('ملفات مفقودة: ' + missing.join('، '), 8000);
}

/* ---------------------------------------------------------------- settings & hotkeys */
const ACTIONS = { play: ['تشغيل / إيقاف', 'Space'], split: ['تقسيم', 'KeyS'], faster: ['تسريع', 'Equal'], slower: ['تبطيء', 'Minus'], del: ['حذف', 'Delete'] };
const keyOf = a => SET.keys[a] || ACTIONS[a][1];
const keyName = code => code.replace('Key', '').replace('Digit', '');
function buildSettings() {
  $('#sRatio').value = SET.ratio; $('#sFps').value = SET.fps; $('#sTc').value = SET.tc;
  $('#sAuto').checked = SET.autosave; $('#sProxy').checked = SET.autoproxy; $('#sHw').value = SET.hw;
  $('#sKeys').innerHTML = Object.entries(ACTIONS).map(([a, [n]]) => `<div class="krow"><span>${n}</span><button class="btn" data-a="${a}">${keyName(keyOf(a))}</button></div>`).join('');
  $$('#sKeys button').forEach(b => b.onclick = () => {
    b.textContent = 'اضغط مفتاحاً…';
    const h = e => { e.preventDefault(); e.stopPropagation(); SET.keys[b.dataset.a] = e.code; saveSet(); b.textContent = keyName(e.code); removeEventListener('keydown', h, true); };
    addEventListener('keydown', h, true);
  });
  if (TA) invoke('cache_size').then(n => $('#sCache').textContent = (n / 1048576).toFixed(1) + ' MB').catch(() => { });
}
function wireSettings() {
  $('#sRatio').onchange = e => { SET.ratio = e.target.value; saveSet(); };
  $('#sFps').onchange = e => { SET.fps = +e.target.value; saveSet(); $('#xfps').value = SET.fps; updHead(); };
  $('#sTc').onchange = e => { SET.tc = e.target.value; saveSet(); renderTimeline(); };
  $('#sAuto').onchange = e => { SET.autosave = e.target.checked; saveSet(); };
  $('#sProxy').onchange = e => { SET.autoproxy = e.target.checked; saveSet(); };
  $('#sHw').onchange = e => { SET.hw = e.target.value; saveSet(); applyHwDefault(); };
  $('#sClear').onclick = async () => { try { const n = await invoke('clear_cache'); toast('تم تفريغ ' + (n / 1048576).toFixed(1) + ' MB'); buildSettings(); } catch (e) { toast('' + e); } };
}
function applyHwDefault() { const m = { none: 'h264', nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf' }; $('#xcodec').value = m[SET.hw] || 'h264'; }

/* ---------------------------------------------------------------- wiring */
const modal = (id, on) => $('#' + id).classList.toggle('on', on);
function wire() {
  $('#imp').onclick = () => pickFiles(['video', 'image']);
  $('#impA').onclick = () => pickFiles(['audio']);
  $('#play').onclick = togglePlay;
  $('#split').onclick = splitClip; $('#dup').onclick = dupClip; $('#del').onclick = () => delClip(false);
  $('#slow').onclick = () => bumpSpeed(-1); $('#fast').onclick = () => bumpSpeed(1);
  $('#undo').onclick = undo; $('#redo').onclick = redo;
  $('#addV').onclick = () => addTrack('video'); $('#addT').onclick = () => addTrack('text'); $('#addA').onclick = () => addTrack('audio');
  $('#zoom').oninput = e => { zoom = +e.target.value; renderTimeline(); };
  $('#ratio').onchange = e => { snap(); P.ratio = e.target.value; refreshAll(); };
  $('#pq').onchange = e => { previewQ = e.target.value; applyQuality(); };
  $('#capBtn').onclick = autoCaptions;
  $('#nBtn').onclick = newProject; $('#oBtn').onclick = openProject; $('#sBtn').onclick = saveProject;
  $('#helpBtn').onclick = () => modal('help', true); $('#hclose').onclick = () => modal('help', false);
  $('#setBtn').onclick = () => { buildSettings(); modal('set', true); }; $('#sclose').onclick = () => modal('set', false);
  $('#expBtn').onclick = () => { if (!P.clips.length) return toast('أضف مقاطع أولاً'); pause(); showDims(); $('#xmsg').textContent = ''; modal('exp', true); };
  $('#xclose').onclick = () => modal('exp', false); $('#xgo').onclick = doExport;
  ['xres', 'xmode'].forEach(i => $('#' + i).onchange = showDims);
  $('#xcont').onchange = e => { if (e.target.value === 'mp4' && $('#xcodec').value === 'prores') $('#xcodec').value = 'h264'; };
  $('#xcodec').onchange = e => { if (e.target.value === 'prores') $('#xcont').value = 'mov'; };

  addEventListener('keydown', e => {
    const t = e.target;
    if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && ['text', 'number'].includes(t.type))) return;
    const ctrl = e.ctrlKey || e.metaKey, c = e.code;
    if (ctrl) {
      if (c === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (c === 'KeyY') { e.preventDefault(); redo(); }
      else if (c === 'KeyB') { e.preventDefault(); splitClip(); }
      else if (c === 'KeyD') { e.preventDefault(); dupClip(); }
      else if (c === 'KeyS') { e.preventDefault(); saveProject(); }
      else if (c === 'KeyE') { e.preventDefault(); $('#expBtn').click(); }
      return;
    }
    if (c === keyOf('play')) { e.preventDefault(); togglePlay(); }
    else if (c === keyOf('split')) splitClip();
    else if (c === keyOf('faster') || c === 'NumpadAdd' || c === 'BracketRight') bumpSpeed(1);
    else if (c === keyOf('slower') || c === 'NumpadSubtract' || c === 'BracketLeft') bumpSpeed(-1);
    else if (c === keyOf('del') || c === 'Backspace') delClip(e.shiftKey);
    else if (c === 'ArrowLeft' || c === 'ArrowRight') { e.preventDefault(); pause(); seek(playhead + (c === 'ArrowRight' ? 1 : -1) / (SET.fps || 30)); }
    else if (c === 'Home') { pause(); seek(0); }
    else if (c === 'End') { pause(); seek(total()); }
    else if (c === 'F1') { e.preventDefault(); modal('help', true); }
    else if (c === 'Escape') ['help', 'set', 'exp'].forEach(m => modal(m, false));
  });
  addEventListener('resize', () => { fitFrame(); renderTimeline(); syncAt(viewT, false); });
}

async function init() {
  buildLibrary(); buildInspector(); bindInputs(); wire(); wireSettings();
  $('#ratio').value = P.ratio; $('#xfps').value = SET.fps; applyHwDefault();
  fitFrame(); refreshAll();
  if (!TA) return toast('هذه الواجهة تعمل داخل برنامج RustCut المثبّت', 8000);
  try { TA.webview.getCurrentWebview().onDragDropEvent(e => { if (e.payload.type === 'drop') importPaths(e.payload.paths); }); } catch (_) { }
  try { TA.event.listen('export-progress', e => { $('#bar i').style.width = e.payload.toFixed(1) + '%'; }); } catch (_) { }
  invoke('ffmpeg_ok').then(ok => { if (!ok) toast('⚠ لم يتم العثور على ffmpeg: لن يعمل التصدير ولا المعاينة المصغّرة', 10000); });
  try {
    const a = await invoke('load_autosave');
    if (a && JSON.parse(a).clips.length && confirm('تم العثور على نسخة محفوظة تلقائياً من آخر جلسة. استعادتها؟')) await loadProjectText(a);
  } catch (_) { }
}
init();
