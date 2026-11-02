//! Multi-track export: builds one ffmpeg filter graph from the timeline.
//! The graph logic mirrors a prototype that was run against real ffmpeg (video, overlays,
//! keyframes, chroma key, masks, transitions, audio mix).

use crate::{add, has_audio};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::cmp::Ordering;
use std::path::PathBuf;

pub type Kf = Vec<[f64; 2]>;

#[derive(Deserialize, Clone)]
pub struct Fx {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub blur: f64,
    pub filter: String,
    pub flip: bool,
}

#[derive(Deserialize, Clone)]
pub struct Mask {
    pub on: bool,
    pub shape: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub blur: f64,
}

#[derive(Deserialize, Clone)]
pub struct Chroma {
    pub on: bool,
    pub color: String,
    pub sim: f64,
    pub blend: f64,
}

#[derive(Deserialize, Clone)]
pub struct Tf {
    pub x: Kf,
    pub y: Kf,
    pub s: Kf,
    pub r: Kf,
    pub o: Kf,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Aud {
    pub vol: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    pub denoise: bool,
    pub pitch: f64,
    pub mute: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub kind: String, // video | image | png
    pub main: bool,
    pub path: String,
    pub png: Option<String>,
    pub start: f64,
    pub dur: f64,
    pub inn: f64,
    pub speed: f64,
    pub fx: Fx,
    pub mask: Mask,
    pub chroma: Option<Chroma>,
    pub tf: Tf,
    pub fade_in: f64,
    pub fade_out: f64,
    pub trans: String,
    pub audio: Option<Aud>,
}

#[derive(Deserialize)]
pub struct AudioItem {
    pub path: String,
    pub start: f64,
    pub dur: f64,
    pub inn: f64,
    pub speed: f64,
    pub audio: Aud,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub w: u32,
    pub h: u32,
    pub fps: u32,
    pub duration: f64,
    pub layers: Vec<Layer>,
    pub audios: Vec<AudioItem>,
    pub container: String,
    pub codec: String,
    pub rate_mode: String,
    pub crf: u32,
    pub bitrate_mbps: f64,
    pub preset: String,
    pub output: String,
}

const TRANSITIONS: &[&str] = &[
    "fade", "dissolve", "fadeblack", "wipeleft", "wiperight", "slideleft", "slideright",
    "circleopen", "circleclose", "pixelize", "radial", "zoomin", "smoothleft",
];

const GEQ_ELLIPSE: &str = "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':\
a='if(lte(pow((2*X-W)/W,2)+pow((2*Y-H)/H,2),1),255,0)'";

// ------------------------------------------------------------------ small helpers

fn f(x: f64) -> String {
    let s = format!("{:.4}", x);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() || s == "-0" {
        "0".to_string()
    } else {
        s
    }
}

fn norm(p: &Kf) -> Vec<(f64, f64)> {
    let mut v: Vec<(f64, f64)> = p.iter().map(|a| (a[0], a[1])).collect();
    v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
    let mut out: Vec<(f64, f64)> = vec![];
    for (t, val) in v {
        if let Some(l) = out.last_mut() {
            if t - l.0 < 1e-3 {
                *l = (t, val);
                continue;
            }
        }
        out.push((t, val));
    }
    if out.is_empty() {
        out.push((0.0, 0.0));
    }
    out
}

fn animated(p: &Kf) -> bool {
    let n = norm(p);
    n.len() > 1 && n.iter().any(|x| (x.1 - n[0].1).abs() > 1e-5)
}

fn first(p: &Kf) -> f64 {
    norm(p)[0].1
}

/// Piecewise-linear keyframe expression in variable `var`, with all times shifted by `shift`.
fn kexpr(p: &Kf, var: &str, shift: f64) -> String {
    let pts: Vec<(f64, f64)> = norm(p).into_iter().map(|(t, v)| (t + shift, v)).collect();
    if pts.len() == 1 || !animated(p) {
        return f(pts[0].1);
    }
    let mut e = f(pts[pts.len() - 1].1);
    for i in (0..pts.len() - 1).rev() {
        let (t0, v0) = pts[i];
        let (t1, v1) = pts[i + 1];
        e = format!(
            "if(lt({var},{}),{}+({}-{})*({var}-{})/{},{e})",
            f(t1), f(v0), f(v1), f(v0), f(t0), f(t1 - t0)
        );
    }
    format!("if(lt({var},{}),{},{e})", f(pts[0].0), f(pts[0].1))
}

fn atempo(mut s: f64) -> String {
    let mut v: Vec<String> = vec![];
    while s > 2.0 {
        v.push("atempo=2.0".into());
        s /= 2.0;
    }
    while s < 0.5 {
        v.push("atempo=0.5".into());
        s /= 0.5;
    }
    v.push(format!("atempo={:.5}", s));
    v.join(",")
}

fn ccm_sat(s: f64) -> String {
    let a = 1.0 - s;
    format!(
        "colorchannelmixer=rr={:.4}:rg={:.4}:rb={:.4}:gr={:.4}:gg={:.4}:gb={:.4}:br={:.4}:bg={:.4}:bb={:.4}",
        a * 0.2126 + s, a * 0.7152, a * 0.0722,
        a * 0.2126, a * 0.7152 + s, a * 0.0722,
        a * 0.2126, a * 0.7152, a * 0.0722 + s
    )
}

fn fx_chain(fx: &Fx, h: i64) -> String {
    let mut s: Vec<String> = vec![];
    let n = ((h as f64 / 180.0).round() as i64).max(2);
    if fx.flip {
        s.push("hflip".into());
    }
    if fx.brightness != 0.0 || fx.contrast != 0.0 {
        let e = format!(
            "min(max((val-maxval/2)*{}+maxval/2+{}*maxval,0),maxval)",
            f((1.0 + fx.contrast / 100.0).max(0.0)),
            f(fx.brightness / 250.0)
        );
        s.push(format!("lutrgb=r='{e}':g='{e}':b='{e}'"));
    }
    if fx.saturation != 0.0 {
        s.push(ccm_sat((1.0 + fx.saturation / 100.0).max(0.0)));
    }
    match fx.filter.as_str() {
        "bw" => s.push(ccm_sat(0.0)),
        "sepia" => s.push("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131".into()),
        "warm" => s.push("colorchannelmixer=rr=1.1:bb=0.9".into()),
        "cool" => s.push("colorchannelmixer=rr=0.9:bb=1.1".into()),
        "vignette" => s.push("vignette=PI/4".into()),
        "sharpen" => s.push("unsharp=5:5:1.0:5:5:0.0".into()),
        "rgbsplit" => s.push(format!("rgbashift=rh=-{n}:bh={n}")),
        "glitch" => s.push(format!("rgbashift=rh=-{n}:bh={n}:gv={},noise=alls=14:allf=t+u", n / 2)),
        "vhs" => {
            let k = (n / 2).max(1);
            s.push(format!("noise=alls=18:allf=t,rgbashift=rh=-{k}:bh={k},curves=preset=vintage"));
        }
        "grain" => s.push("noise=alls=22:allf=t".into()),
        "shake" => s.push(
            "crop=w='iw*0.94':h='ih*0.94':x='(iw-ow)/2*(1+sin(t*25))':y='(ih-oh)/2*(1+cos(t*31))',\
             scale=w='iw/0.94':h='ih/0.94'"
                .into(),
        ),
        "pixelate" => {
            let k = ((h as f64 / 60.0).round() as i64).max(8);
            s.push(format!(
                "scale=trunc(iw/{k}):trunc(ih/{k}):flags=neighbor,scale=iw*{k}:ih*{k}:flags=neighbor"
            ));
        }
        "negative" => s.push("negate".into()),
        _ => {}
    }
    if fx.blur > 0.05 {
        s.push(format!("gblur=sigma={:.2}", fx.blur * h as f64 / 1080.0));
    }
    s.join(",")
}

fn gap(fc: &mut Vec<String>, gcount: &mut usize, w: i64, h: i64, fps: u32, d: f64) -> String {
    *gcount += 1;
    let lab = format!("g{}", *gcount);
    fc.push(format!(
        "color=c=black:s={w}x{h}:r={fps}:d={},format=yuv420p,setsar=1[{lab}]",
        f(d)
    ));
    lab
}

/// Registers one source file as an ffmpeg input and returns its input index.
fn src_input(
    args: &mut Vec<String>,
    idx: &mut usize,
    l: &Layer,
    fps: u32,
    temps: &mut Vec<PathBuf>,
    n: usize,
) -> Result<usize, String> {
    let mut path = l.path.clone();
    if l.kind == "png" {
        let data = l.png.as_deref().ok_or("png layer without data")?;
        let b64 = data.split(',').last().unwrap_or("");
        let bytes = STANDARD.decode(b64).map_err(|e| e.to_string())?;
        let p = std::env::temp_dir().join(format!("rustcut_{}_{}.png", std::process::id(), n));
        std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
        path = p.to_string_lossy().to_string();
        temps.push(p);
    }
    if l.kind == "video" {
        args.extend([
            "-ss".to_string(), f(l.inn),
            "-t".to_string(), f(l.dur * l.speed.max(0.05)),
            "-i".to_string(), path,
        ]);
    } else {
        args.extend([
            "-loop".to_string(), "1".to_string(),
            "-framerate".to_string(), fps.to_string(),
            "-t".to_string(), f(l.dur),
            "-i".to_string(), path,
        ]);
    }
    *idx += 1;
    Ok(*idx - 1)
}

fn achain(src: &str, a: &Aud, start: f64, dur: f64, speed: f64, extra_in: f64, extra_out: f64) -> String {
    let mut s = format!("{src}aresample=48000,asetpts=PTS-STARTPTS");
    if a.pitch.abs() > 0.01 {
        let r = 2f64.powf(a.pitch / 12.0);
        s.push_str(&format!(",asetrate={:.2},aresample=48000,{}", 48000.0 * r, atempo(1.0 / r)));
    }
    if (speed - 1.0).abs() > 0.001 {
        s.push(',');
        s.push_str(&atempo(speed));
    }
    if a.denoise {
        s.push_str(",highpass=f=80,afftdn=nr=12:nf=-30");
    }
    s.push_str(&format!(",volume={:.3}", a.vol.clamp(0.0, 4.0)));
    let fi = a.fade_in.max(extra_in);
    let fo = a.fade_out.max(extra_out);
    if fi > 0.01 {
        s.push_str(&format!(",afade=t=in:st=0:d={}", f(fi)));
    }
    if fo > 0.01 {
        s.push_str(&format!(",afade=t=out:st={}:d={}", f((dur - fo).max(0.0)), f(fo)));
    }
    s.push_str(",aformat=sample_fmts=fltp:channel_layouts=stereo");
    let ms = (start * 1000.0).round() as i64;
    if ms > 0 {
        s.push_str(&format!(",adelay={ms}|{ms}"));
    }
    s
}

// ------------------------------------------------------------------ the graph

/// Returns (ffmpeg args up to and including the maps, temp files to delete afterwards).
pub fn build(ff: &PathBuf, job: &Job) -> Result<(Vec<String>, Vec<PathBuf>), String> {
    let (w, h, fps) = (job.w as i64, job.h as i64, job.fps.max(1));
    let total = job.duration.max(0.1);
    let n = job.layers.len();
    let mut args: Vec<String> = vec![];
    let mut fc: Vec<String> = vec![];
    let mut temps: Vec<PathBuf> = vec![];
    let mut idx = 0usize;
    let mut vin: Vec<Option<usize>> = vec![None; n];
    let mut gcount = 0usize;
    let mut xc = 0usize;

    let mut main_idx: Vec<usize> = (0..n).filter(|&i| job.layers[i].main).collect();
    main_idx.sort_by(|&a, &b| {
        job.layers[a].start.partial_cmp(&job.layers[b].start).unwrap_or(Ordering::Equal)
    });
    let vis_idx: Vec<usize> = (0..n).filter(|&i| !job.layers[i].main).collect();

    // ---------------- main track (V1): sequential base with gaps, concat and xfade
    let mut cur: Option<String> = None;
    let mut cur_end = 0.0f64;
    let mut prev_trans = String::from("none");
    for &i in &main_idx {
        let l = &job.layers[i];
        let vi = src_input(&mut args, &mut idx, l, fps, &mut temps, i)?;
        vin[i] = Some(vi);
        let pre = if l.kind == "video" {
            format!("[{vi}:v]setpts=(PTS-STARTPTS)/{:.5},fps={fps}", l.speed.max(0.05))
        } else {
            format!("[{vi}:v]fps={fps},setpts=PTS-STARTPTS")
        };
        let mut chain = format!(
            "{pre},scale={w}:{h}:force_original_aspect_ratio=decrease,\
             pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p"
        );
        if l.kind == "video" {
            let fxs = fx_chain(&l.fx, h);
            if !fxs.is_empty() {
                chain.push(',');
                chain.push_str(&fxs);
            }
        }
        let mut lab = format!("b{i}");
        fc.push(format!("{chain}[{lab}]"));

        let m = &l.mask;
        if l.kind == "video" && m.on && m.blur > 0.05 {
            let cx = (((m.x * w as f64).round() as i64) & !1).clamp(0, w - 2);
            let cy = (((m.y * h as f64).round() as i64) & !1).clamp(0, h - 2);
            let cw = ((m.w * w as f64).round() as i64).clamp(2, w - cx) & !1;
            let chh = ((m.h * h as f64).round() as i64).clamp(2, h - cy) & !1;
            let mut sub = format!(
                "[mb{i}]crop={cw}:{chh}:{cx}:{cy},gblur=sigma={:.2}",
                m.blur * h as f64 / 1080.0
            );
            if m.shape == "ellipse" {
                sub.push(',');
                sub.push_str(GEQ_ELLIPSE);
            }
            fc.push(format!("[{lab}]split[ma{i}][mb{i}]"));
            fc.push(format!("{sub}[mc{i}]"));
            fc.push(format!("[ma{i}][mc{i}]overlay={cx}:{cy}:format=auto[m{i}]"));
            lab = format!("m{i}");
        }
        fc.push(format!("[{lab}]scale={w}:{h},setsar=1,format=yuv420p[v{i}]"));
        lab = format!("v{i}");
        let end = l.start + l.dur;

        match cur.clone() {
            None => {
                if l.start > 0.001 {
                    let g = gap(&mut fc, &mut gcount, w, h, fps, l.start);
                    xc += 1;
                    fc.push(format!("[{g}][{lab}]concat=n=2:v=1:a=0,fps={fps}[x{xc}]"));
                    cur = Some(format!("x{xc}"));
                } else {
                    cur = Some(lab);
                }
                cur_end = end;
            }
            Some(c) => {
                let mut c = c;
                let mut d_gap = l.start - cur_end;
                if d_gap > 0.001 {
                    let g = gap(&mut fc, &mut gcount, w, h, fps, d_gap);
                    xc += 1;
                    fc.push(format!("[{c}][{g}]concat=n=2:v=1:a=0,fps={fps}[x{xc}]"));
                    c = format!("x{xc}");
                    cur_end += d_gap;
                    d_gap = 0.0;
                }
                xc += 1;
                if d_gap < -0.001 {
                    let d = -d_gap;
                    let tr = if TRANSITIONS.contains(&prev_trans.as_str()) { prev_trans.as_str() } else { "fade" };
                    fc.push(format!(
                        "[{c}][{lab}]xfade=transition={tr}:duration={}:offset={},fps={fps}[x{xc}]",
                        f(d), f(l.start)
                    ));
                } else {
                    fc.push(format!("[{c}][{lab}]concat=n=2:v=1:a=0,fps={fps}[x{xc}]"));
                }
                cur = Some(format!("x{xc}"));
                cur_end = end;
            }
        }
        prev_trans = l.trans.clone();
    }
    let mut cur = match cur {
        None => {
            cur_end = total;
            gap(&mut fc, &mut gcount, w, h, fps, total)
        }
        Some(c) => c,
    };
    if total - cur_end > 0.001 {
        let g = gap(&mut fc, &mut gcount, w, h, fps, total - cur_end);
        xc += 1;
        fc.push(format!("[{cur}][{g}]concat=n=2:v=1:a=0,fps={fps}[x{xc}]"));
        cur = format!("x{xc}");
    }

    // ---------------- overlay layers, bottom -> top
    for &i in &vis_idx {
        let l = &job.layers[i];
        let (start, dur) = (l.start, l.dur);
        let vi = src_input(&mut args, &mut idx, l, fps, &mut temps, i)?;
        vin[i] = Some(vi);
        let mut chain = match l.kind.as_str() {
            "png" => format!("[{vi}:v]fps={fps},setpts=PTS-STARTPTS,format=rgba"),
            "video" => format!(
                "[{vi}:v]setpts=(PTS-STARTPTS)/{:.5},fps={fps},\
                 scale={w}:{h}:force_original_aspect_ratio=decrease,setsar=1,format=rgba",
                l.speed.max(0.05)
            ),
            _ => format!(
                "[{vi}:v]fps={fps},setpts=PTS-STARTPTS,\
                 scale={w}:{h}:force_original_aspect_ratio=decrease,setsar=1,format=rgba"
            ),
        };
        if l.kind == "video" {
            let fxs = fx_chain(&l.fx, h);
            if !fxs.is_empty() {
                chain.push(',');
                chain.push_str(&fxs);
            }
        }
        let mut lab = format!("o{i}");
        fc.push(format!("{chain}[{lab}]"));

        let m = &l.mask;
        if l.kind == "video" && m.on && m.blur > 0.05 {
            let (mx, my, mw, mh) = (f(m.x), f(m.y), f(m.w), f(m.h));
            let mut sub = format!(
                "[ob{i}]crop=w='iw*{mw}':h='ih*{mh}':x='iw*{mx}':y='ih*{my}',gblur=sigma={:.2}",
                m.blur * h as f64 / 1080.0
            );
            if m.shape == "ellipse" {
                sub.push(',');
                sub.push_str(GEQ_ELLIPSE);
            }
            fc.push(format!("[{lab}]split[oa{i}][ob{i}]"));
            fc.push(format!("{sub}[oc{i}]"));
            fc.push(format!(
                "[oa{i}][oc{i}]overlay=x='main_w*{mx}':y='main_h*{my}':format=auto[om{i}]"
            ));
            lab = format!("om{i}");
        }

        let mut ch: Vec<String> = vec![];
        if l.kind == "video" {
            if let Some(ck) = &l.chroma {
                let hex_ok = ck.color.len() == 6 && ck.color.chars().all(|c| c.is_ascii_hexdigit());
                if ck.on && hex_ok {
                    ch.push(format!(
                        "chromakey=color=0x{}:similarity={}:blend={},format=rgba",
                        ck.color, f(ck.sim), f(ck.blend)
                    ));
                }
            }
        }
        if l.fade_in > 0.01 {
            ch.push(format!("fade=t=in:st=0:d={}:alpha=1", f(l.fade_in)));
        }
        if l.fade_out > 0.01 {
            ch.push(format!("fade=t=out:st={}:d={}:alpha=1", f((dur - l.fade_out).max(0.0)), f(l.fade_out)));
        }
        let tf = &l.tf;
        if animated(&tf.o) {
            ch.push(format!(
                "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*max(0,min(1,{}))'",
                kexpr(&tf.o, "T", 0.0)
            ));
        } else {
            let o = first(&tf.o).clamp(0.0, 1.0);
            if (o - 1.0).abs() > 0.004 {
                ch.push(format!("colorchannelmixer=aa={}", f(o)));
            }
        }
        if animated(&tf.r) || first(&tf.r).abs() > 0.01 {
            ch.push(format!(
                "rotate=a='({})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none",
                kexpr(&tf.r, "t", 0.0)
            ));
        }
        if animated(&tf.s) {
            let se = kexpr(&tf.s, "t", 0.0);
            ch.push(format!("scale=w='max(2,iw*({se}))':h='max(2,ih*({se}))':eval=frame"));
        } else {
            let sv = first(&tf.s);
            if (sv - 1.0).abs() > 0.004 {
                ch.push(format!("scale=w='max(2,iw*{0})':h='max(2,ih*{0})'", f(sv.max(0.01))));
            }
        }
        ch.push(format!("setpts=PTS+{}/TB", f(start)));
        fc.push(format!("[{lab}]{}[L{i}]", ch.join(",")));

        let xe = if animated(&tf.x) { kexpr(&tf.x, "t", start) } else { f(first(&tf.x)) };
        let ye = if animated(&tf.y) { kexpr(&tf.y, "t", start) } else { f(first(&tf.y)) };
        xc += 1;
        fc.push(format!(
            "[{cur}][L{i}]overlay=x='W*({xe})-w/2':y='H*({ye})-h/2':eof_action=pass:format=auto[x{xc}]"
        ));
        cur = format!("x{xc}");
    }

    // ---------------- audio: every clip's sound delayed to its start, then mixed
    let mut ov_in = vec![0.0f64; n];
    let mut ov_out = vec![0.0f64; n];
    for k in 1..main_idx.len() {
        let (a, b) = (&job.layers[main_idx[k - 1]], &job.layers[main_idx[k]]);
        let ov = a.start + a.dur - b.start;
        if ov > 0.001 {
            ov_out[main_idx[k - 1]] = ov;
            ov_in[main_idx[k]] = ov;
        }
    }
    let mut alabs: Vec<String> = vec![];
    for i in 0..n {
        let l = &job.layers[i];
        let a = match &l.audio {
            Some(a) if l.kind == "video" && !a.mute => a,
            _ => continue,
        };
        if !has_audio(ff, &l.path) {
            continue;
        }
        let vi = vin[i].ok_or("missing input")?;
        let lab = format!("a{i}");
        fc.push(format!(
            "{}[{lab}]",
            achain(&format!("[{vi}:a]"), a, l.start, l.dur, l.speed.max(0.05), ov_in[i], ov_out[i])
        ));
        alabs.push(lab);
    }
    for (j, it) in job.audios.iter().enumerate() {
        if it.audio.mute {
            continue;
        }
        args.extend([
            "-ss".to_string(), f(it.inn),
            "-t".to_string(), f(it.dur * it.speed.max(0.05)),
            "-i".to_string(), it.path.clone(),
        ]);
        let ai = idx;
        idx += 1;
        let lab = format!("s{j}");
        fc.push(format!(
            "{}[{lab}]",
            achain(&format!("[{ai}:a]"), &it.audio, it.start, it.dur, it.speed.max(0.05), 0.0, 0.0)
        ));
        alabs.push(lab);
    }
    match alabs.len() {
        0 => fc.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={}[aout]", f(total))),
        1 => fc.push(format!("[{}]atrim=end={},asetpts=PTS-STARTPTS[aout]", alabs[0], f(total))),
        k => {
            let ins: String = alabs.iter().map(|l| format!("[{l}]")).collect();
            fc.push(format!(
                "{ins}amix=inputs={k}:normalize=0:dropout_transition=0,atrim=end={},asetpts=PTS-STARTPTS[aout]",
                f(total)
            ));
        }
    }

    args.extend([
        "-filter_complex".to_string(), fc.join(";"),
        "-map".to_string(), format!("[{cur}]"),
        "-map".to_string(), "[aout]".to_string(),
        "-t".to_string(), f(total),
    ]);
    Ok((args, temps))
}

/// Encoder / container arguments.
pub fn codec_args(job: &Job) -> Vec<String> {
    let mut a: Vec<String> = vec![];
    let preset = match job.preset.as_str() {
        "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" => {
            job.preset.as_str()
        }
        _ => "medium",
    };
    let crf = job.crf.clamp(0, 51).to_string();
    let mbps = job.bitrate_mbps.clamp(0.5, 400.0);
    let (br, mx, bs) = (format!("{:.1}M", mbps), format!("{:.1}M", mbps * 1.5), format!("{:.1}M", mbps * 2.0));
    let by_rate = job.rate_mode == "bitrate";
    let mut prores = false;
    match job.codec.as_str() {
        "h265" => {
            add(&mut a, &["-c:v", "libx265", "-preset", preset, "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]);
            if by_rate { add(&mut a, &["-b:v", br.as_str(), "-maxrate", mx.as_str(), "-bufsize", bs.as_str()]); }
            else { add(&mut a, &["-crf", crf.as_str()]); }
        }
        "prores" => {
            prores = true;
            add(&mut a, &["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]);
        }
        "h264_nvenc" | "hevc_nvenc" => {
            let enc = if job.codec == "hevc_nvenc" { "hevc_nvenc" } else { "h264_nvenc" };
            add(&mut a, &["-c:v", enc, "-preset", "p5", "-pix_fmt", "yuv420p"]);
            if enc == "hevc_nvenc" { add(&mut a, &["-tag:v", "hvc1"]); }
            if by_rate { add(&mut a, &["-rc", "vbr", "-b:v", br.as_str(), "-maxrate", mx.as_str(), "-bufsize", bs.as_str()]); }
            else { add(&mut a, &["-rc", "vbr", "-cq", crf.as_str(), "-b:v", "0"]); }
        }
        "h264_qsv" => {
            add(&mut a, &["-c:v", "h264_qsv", "-pix_fmt", "nv12"]);
            if by_rate { add(&mut a, &["-b:v", br.as_str(), "-maxrate", mx.as_str()]); }
            else { add(&mut a, &["-global_quality", crf.as_str()]); }
        }
        "h264_amf" => {
            add(&mut a, &["-c:v", "h264_amf", "-pix_fmt", "yuv420p"]);
            if by_rate { add(&mut a, &["-b:v", br.as_str(), "-maxrate", mx.as_str()]); }
            else { add(&mut a, &["-rc", "cqp", "-qp_i", crf.as_str(), "-qp_p", crf.as_str(), "-qp_b", crf.as_str()]); }
        }
        _ => {
            add(&mut a, &["-c:v", "libx264", "-preset", preset, "-pix_fmt", "yuv420p"]);
            if by_rate { add(&mut a, &["-b:v", br.as_str(), "-maxrate", mx.as_str(), "-bufsize", bs.as_str()]); }
            else { add(&mut a, &["-crf", crf.as_str()]); }
        }
    }
    if prores {
        add(&mut a, &["-c:a", "pcm_s16le"]);
    } else {
        add(&mut a, &["-c:a", "aac", "-b:a", "192k"]);
    }
    add(&mut a, &["-movflags", "+faststart"]);
    a
}

/// Output path with the extension that matches the container (prores forces .mov).
pub fn output_path(job: &Job) -> String {
    let want = if job.codec == "prores" || job.container == "mov" { "mov" } else { "mp4" };
    let p = PathBuf::from(&job.output);
    p.with_extension(want).to_string_lossy().to_string()
}
