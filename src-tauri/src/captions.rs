//! Auto-captions: extracts the clip's audio with ffmpeg and transcribes it offline with
//! whisper.cpp (whisper-cli.exe + a ggml model). Both are optional resources: when they are
//! missing, the command returns a clear error and the rest of the app keeps working.

use crate::{cache_dir, cmd, ffmpeg_path};
use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct Seg {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

fn whisper_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = vec![];
    if let Ok(r) = app.path().resource_dir() {
        v.push(r.join("bin").join("whisper"));
        v.push(r.join("whisper"));
    }
    if let Ok(e) = std::env::current_exe() {
        if let Some(d) = e.parent() {
            v.push(d.join("bin").join("whisper"));
            v.push(d.join("whisper"));
        }
    }
    if let Ok(d) = app.path().app_data_dir() {
        v.push(d.join("whisper"));
    }
    v
}

fn find_engine(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let mut exe: Option<PathBuf> = None;
    let mut best: Option<(i32, PathBuf)> = None;
    for d in whisper_dirs(app) {
        for name in ["whisper-cli.exe", "main.exe"] {
            let p = d.join(name);
            if exe.is_none() && p.exists() {
                exe = Some(p);
            }
        }
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.starts_with("ggml-") && name.ends_with(".bin") {
                    let rank = if name.contains("large") { 5 }
                        else if name.contains("medium") { 4 }
                        else if name.contains("small") { 3 }
                        else if name.contains("base") { 2 }
                        else { 1 };
                    if best.as_ref().map(|b| rank > b.0).unwrap_or(true) {
                        best = Some((rank, e.path()));
                    }
                }
            }
        }
    }
    match (exe, best) {
        (Some(e), Some((_, m))) => Some((e, m)),
        _ => None,
    }
}

fn parse_ts(s: &str) -> Option<f64> {
    let s = s.trim().replace(',', ".");
    let p: Vec<&str> = s.split(':').collect();
    if p.len() != 3 {
        return None;
    }
    Some(p[0].parse::<f64>().ok()? * 3600.0 + p[1].parse::<f64>().ok()? * 60.0 + p[2].parse::<f64>().ok()?)
}

pub fn parse_srt(text: &str) -> Vec<Seg> {
    let mut out = vec![];
    let norm = text.replace("\r\n", "\n");
    for block in norm.split("\n\n") {
        let lines: Vec<&str> = block.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
        let Some(pos) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let mut it = lines[pos].split("-->");
        let (Some(a), Some(b)) = (it.next(), it.next()) else { continue };
        let (Some(start), Some(end)) = (parse_ts(a), parse_ts(b)) else { continue };
        let body = lines[pos + 1..].join(" ").trim().to_string();
        let skip = body.is_empty()
            || (body.starts_with('[') && body.ends_with(']'))
            || (body.starts_with('(') && body.ends_with(')'));
        if !skip {
            out.push(Seg { start, end, text: body });
        }
    }
    out
}

#[tauri::command]
pub fn captions_ready(app: AppHandle) -> bool {
    find_engine(&app).is_some()
}

#[tauri::command]
pub async fn transcribe(
    app: AppHandle,
    path: String,
    inn: f64,
    dur: f64,
    lang: String,
) -> Result<Vec<Seg>, String> {
    let ff = ffmpeg_path(&app);
    let (exe, model) = find_engine(&app).ok_or_else(|| {
        "محرك التفريغ (whisper) غير مثبّت. ضع whisper-cli.exe وملف ggml-*.bin داخل مجلد bin\\whisper".to_string()
    })?;
    let dir = cache_dir(&app, "captions")?;
    tauri::async_runtime::spawn_blocking(move || {
        let wav = dir.join("cap.wav");
        let prefix = dir.join("cap");
        let srt = dir.join("cap.srt");
        let _ = std::fs::remove_file(&srt);

        let ss = format!("{:.3}", inn);
        let tt = format!("{:.3}", dur.max(0.5));
        let o = cmd(&ff)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-ss", ss.as_str(),
                   "-t", tt.as_str(), "-i", path.as_str(),
                   "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
            .arg(&wav)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).to_string());
        }

        let lang = match lang.as_str() {
            "ar" | "en" | "auto" | "fr" | "tr" | "fa" | "ku" | "es" | "de" => lang.clone(),
            _ => "auto".to_string(),
        };
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8).to_string();
        let o = cmd(&exe)
            .args(["-m"])
            .arg(&model)
            .args(["-f"])
            .arg(&wav)
            .args(["-l", lang.as_str(), "-osrt", "-t", threads.as_str(), "-of"])
            .arg(&prefix)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("whisper: {e}"))?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).to_string());
        }
        let text = std::fs::read_to_string(&srt).map_err(|e| format!("لم يتم إنشاء ملف الترجمة: {e}"))?;
        let _ = std::fs::remove_file(&wav);
        Ok(parse_srt(&text))
    })
    .await
    .map_err(|e| e.to_string())?
}
