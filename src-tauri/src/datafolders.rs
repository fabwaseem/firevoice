//! Where FireVoice keeps the user's data, written down for the uninstaller.
//!
//! The data folder (`~/.firevoice`, or `FIREVOICE_HOME`) holds voices, history, projects, renders, and by default the
//! engines and model weights; Settings can move engines or weights elsewhere (`settings.json`). When someone ticks
//! "delete all FireVoice data" while uninstalling, the uninstaller (src-tauri/windows/hooks.nsh) deletes the folders
//! listed in `<app local data>/data-folders.txt`, which the app refreshes on every start.
//!
//! Only folders that are clearly FireVoice's are ever listed: a custom engines or weights folder must look like one
//! (engine environments, weights) and may never be a drive root, the user's profile or one of its main folders.

use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

fn data_home(app: &AppHandle) -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("FIREVOICE_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(h));
    }
    app.path().home_dir().ok().map(|h| h.join(".firevoice"))
}

/// Never delete these, or anything above them.
fn protected(app: &AppHandle) -> Vec<PathBuf> {
    let p = app.path();
    let mut v: Vec<PathBuf> = [p.home_dir(), p.desktop_dir(), p.document_dir(), p.download_dir(), p.audio_dir(), p.video_dir(), p.picture_dir()]
        .into_iter()
        .filter_map(Result::ok)
        .collect();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "SystemRoot", "LOCALAPPDATA", "APPDATA"] {
        if let Some(x) = std::env::var_os(var) {
            v.push(PathBuf::from(x));
        }
    }
    v
}

fn normal_parts(p: &Path) -> usize {
    p.components().filter(|c| matches!(c, Component::Normal(_))).count()
}

fn named_like_ours(p: &Path) -> bool {
    p.file_name().map(|n| n.to_string_lossy().to_lowercase()).is_some_and(|n| n.contains("firevoice") || n.contains("weights") || n.contains("engines"))
}

fn safe(p: &Path, keep: &[PathBuf]) -> bool {
    if !p.is_absolute() || !p.is_dir() {
        return false;
    }
    let p = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    // not a drive root or a top-level folder unless it is plainly named for FireVoice
    if normal_parts(&p) < 2 && !named_like_ours(&p) {
        return false;
    }
    !keep.iter().map(|k| fs::canonicalize(k).unwrap_or_else(|_| k.clone())).any(|k| k == p || k.starts_with(&p))
}

/// An engines folder holds engine environments (folders with pyvenv.cfg) or a weights folder.
fn looks_like_engines(p: &Path) -> bool {
    p.join("weights").is_dir()
        || fs::read_dir(p).map(|rd| rd.flatten().any(|e| e.path().join("pyvenv.cfg").is_file())).unwrap_or(false)
}

/// A weights folder holds one folder per model and is named for what it is.
fn looks_like_weights(p: &Path) -> bool {
    named_like_ours(p) && fs::read_dir(p).map(|rd| rd.flatten().all(|e| e.path().is_dir())).unwrap_or(false)
}

/// Refresh the list (best effort: a failure only means the uninstaller falls back to `~/.firevoice`).
pub fn record(app: &AppHandle) {
    let Some(home) = data_home(app) else { return };
    let keep = protected(app);
    let mut dirs: Vec<PathBuf> = Vec::new();
    if safe(&home, &keep) {
        dirs.push(home.clone());
    }
    let settings: serde_json::Value = fs::read_to_string(home.join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    for (key, ok) in [("engines_dir", looks_like_engines as fn(&Path) -> bool), ("weights_dir", looks_like_weights)] {
        let Some(s) = settings.get(key).and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) else { continue };
        let p = PathBuf::from(s);
        // inside the data folder already, or not clearly ours: leave it out
        if p.starts_with(&home) || !ok(&p) || !safe(&p, &keep) {
            continue;
        }
        dirs.push(p);
    }
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let _ = fs::create_dir_all(&dir);
    let text: String = dirs.iter().map(|d| format!("{}\n", d.display())).collect();
    if let Err(e) = fs::write(dir.join("data-folders.txt"), text) {
        log::warn!("could not record data folders: {e}");
    }
}
