#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod captions;
mod export;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------- helpers

fn ffmpeg_path(app: &AppHandle) -> PathBuf {
    let mut c: Vec<PathBuf> = vec![];
    if let Ok(r) = app.path().resource_dir() {
        c.push(r.join("bin").join("ffmpeg.exe"));
        c.push(r.join("ffmpeg.exe"));
    }
    if let Ok(e) = std::env::current_exe() {
        if let Some(d) = e.parent() {
            c.push(d.join("bin").join("ffmpeg.exe"));
            c.push(d.join("ffmpeg.exe"));
        }
    }
    c.into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

/// A Command that never flashes a console window on Windows.
fn cmd(p: &PathBuf) -> Command {
    let mut c = Command::new(p);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

fn key(path: &str, tag: &str) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{:x}_{}", h.finish(), tag)
}

fn cache_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(sub);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn has_audio(ff: &PathBuf, p: &str) -> bool {
    cmd(ff)
        .args(["-hide_banner", "-i", p])
        .stdin(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stderr).contains("Audio:"))
        .unwrap_or(false)
}

fn add(args: &mut Vec<String>, v: &[&str]) {
    args.extend(v.iter().map(|s| s.to_string()));
}

fn dir_size(p: &PathBuf) -> u64 {
    let mut n = 0u64;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                n += dir_size(&path);
            } else if let Ok(m) = e.metadata() {
                n += m.len();
            }
        }
    }
    n
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn ffmpeg_ok(app: AppHandle) -> bool {
    cmd(&ffmpeg_path(&app))
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Low-resolution, short-GOP proxy: smooth preview + instant hover scrubbing,
/// and a fallback for codecs the WebView cannot play.
#[tauri::command]
async fn make_proxy(app: AppHandle, path: String, height: u32) -> Result<String, String> {
    let ff = ffmpeg_path(&app);
    let dir = cache_dir(&app, "proxies")?;
    let out = dir.join(format!("{}.mp4", key(&path, &height.to_string())));
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = dir.join(format!("{}.part.mp4", key(&path, &height.to_string())));
        let vf = format!("scale=-2:'min({height},ih)'");
        let o = cmd(&ff)
            .args([
                "-y", "-hide_banner", "-loglevel", "error", "-i", path.as_str(),
                "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", vf.as_str(),
                "-c:v", "libx264", "-preset", "ultrafast", "-crf", "27",
                "-g", "8", "-keyint_min", "8", "-sc_threshold", "0",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
                "-movflags", "+faststart",
            ])
            .arg(&tmp)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).to_string());
        }
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn make_thumb(app: AppHandle, path: String) -> Result<String, String> {
    let ff = ffmpeg_path(&app);
    let dir = cache_dir(&app, "thumbs")?;
    let out = dir.join(format!("{}.jpg", key(&path, "t")));
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        for ss in ["0.5", "0"] {
            let _ = cmd(&ff)
                .args([
                    "-y", "-hide_banner", "-loglevel", "error", "-ss", ss, "-i", path.as_str(),
                    "-frames:v", "1", "-vf", "scale=-2:90",
                ])
                .arg(&out)
                .stdin(Stdio::null())
                .output();
            if out.exists() {
                return Ok(out.to_string_lossy().to_string());
            }
        }
        Err("thumbnail failed".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Duration (seconds) and whether a file has video / audio streams, parsed from ffmpeg's banner.
#[tauri::command]
async fn probe(app: AppHandle, path: String) -> Result<(f64, bool, bool), String> {
    let ff = ffmpeg_path(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let o = cmd(&ff)
            .args(["-hide_banner", "-i", path.as_str()])
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())?;
        let log = String::from_utf8_lossy(&o.stderr).to_string();
        let mut dur = 0.0;
        if let Some(i) = log.find("Duration:") {
            let t: String = log[i + 9..].trim_start().chars().take(11).collect();
            let p: Vec<&str> = t.split(':').collect();
            if p.len() == 3 {
                dur = p[0].parse::<f64>().unwrap_or(0.0) * 3600.0
                    + p[1].parse::<f64>().unwrap_or(0.0) * 60.0
                    + p[2].parse::<f64>().unwrap_or(0.0);
            }
        }
        Ok((dur, log.contains("Video:"), log.contains("Audio:")))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- project / cache

#[tauri::command]
fn write_text(path: String, text: String) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn autosave(app: AppHandle, text: String) -> Result<(), String> {
    let p = cache_dir(&app, "autosave")?.join("project.json");
    std::fs::write(p, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_autosave(app: AppHandle) -> Option<String> {
    let p = cache_dir(&app, "autosave").ok()?.join("project.json");
    std::fs::read_to_string(p).ok()
}

#[tauri::command]
fn cache_size(app: AppHandle) -> u64 {
    let mut n = 0;
    for s in ["proxies", "thumbs", "captions"] {
        if let Ok(d) = cache_dir(&app, s) {
            n += dir_size(&d);
        }
    }
    n
}

#[tauri::command]
fn clear_cache(app: AppHandle) -> Result<u64, String> {
    let before = cache_size(app.clone());
    for s in ["proxies", "thumbs", "captions"] {
        let d = cache_dir(&app, s)?;
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::create_dir_all(&d);
    }
    Ok(before)
}

// ---------------------------------------------------------------- export

#[tauri::command]
async fn export_video(app: AppHandle, job: export::Job) -> Result<String, String> {
    let ff = ffmpeg_path(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let output = export::output_path(&job);
        let (rest, temps) = export::build(&ff, &job)?;
        let mut a: Vec<String> = vec![];
        add(&mut a, &["-y", "-hide_banner", "-nostats", "-progress", "pipe:1"]);
        a.extend(rest);
        a.extend(export::codec_args(&job));
        a.push(output.clone());

        let spawned = cmd(&ff)
            .args(&a)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                for t in &temps {
                    let _ = std::fs::remove_file(t);
                }
                return Err(format!("تعذر تشغيل ffmpeg: {e}"));
            }
        };

        let mut err = child.stderr.take().ok_or("no stderr")?;
        let log_thread = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = err.read_to_string(&mut s);
            s
        });

        let total = job.duration.max(0.1);
        let out = child.stdout.take().ok_or("no stdout")?;
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<f64>() {
                    let pct = (us / 1e6 / total * 100.0).clamp(0.0, 100.0);
                    let _ = app.emit("export-progress", pct);
                }
            }
        }

        let st = child.wait().map_err(|e| e.to_string());
        let log = log_thread.join().unwrap_or_default();
        for t in &temps {
            let _ = std::fs::remove_file(t);
        }
        if st?.success() {
            let _ = app.emit("export-progress", 100.0);
            Ok(output)
        } else {
            let tail: Vec<&str> = log.lines().rev().take(14).collect();
            Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ffmpeg_ok,
            make_proxy,
            make_thumb,
            probe,
            write_text,
            read_text,
            autosave,
            load_autosave,
            cache_size,
            clear_cache,
            export_video,
            captions::captions_ready,
            captions::transcribe
        ])
        .run(tauri::generate_context!())
        .expect("error while running RustCut");
}
