'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TA = window.__TAURI__ || null;
const invoke = (c, a) => TA.core.invoke(c, a);
const asset = p => TA.core.convertFileSrc(p);

const SET = Object.assign({ ratio: '16:9', fps: 30, tc: 'sec', autosave: true, hw: 'none', autoproxy: true, keys: {} },
  (() => { try { return JSON.parse(localStorage.getItem('rc.set') || '{}'); } catch (_) { return {}; } })());
const saveSet = () => { try { localStorage.setItem('rc.set', JSON.stringify(SET)); } catch (_) { } };

function fmt(t) {
  t = Math.max(0, t);
  if (SET.tc === 'tc') {
    const fps = SET.fps || 30, ff = Math.floor((t % 1) * fps), s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
    const p = n => String(n).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(s)}:${p(ff)}`;
  }
  const m = Math.floor(t / 60), s = t % 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(1).padStart(4, '0');
}
let toastT;
function toast(m, ms = 2600) {
  const t = $('#toast'); t.textContent = m; t.style.display = 'block';
  clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', ms);
}
const VEXT = /\.(mp4|mov|mkv|avi|webm|m4v|wmv|flv|ts|mts|m2ts)$/i;
const IEXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
const AEXT = /\.(mp3|wav|m4a|aac|ogg|flac|wma)$/i;
const kindOfPath = p => VEXT.test(p) ? 'video' : IEXT.test(p) ? 'image' : AEXT.test(p) ? 'audio' : null;
const LADDER = [.1, .25, .5, .75, 1, 1.25, 1.5, 2, 3, 4, 8];
