//! Carry an install across a change of app identifier.
//!
//! The identifier names the app's own folders (`%LOCALAPPDATA%\<id>`: the engine runtime, the web view's storage with
//! the app's settings, logs; `%APPDATA%\<id>`). FireVoice was `dev.firestack.firevoice` up to 1.5.0 and is
//! `app.fabwaseem.firevoice` since 1.5.1. On the first start after that change the old folders are renamed to the new
//! names, before anything opens them, so settings and the runtime carry over and nothing is set up again.
//!
//! Voices, history, engines and models live in `~/.firevoice`, which does not depend on the identifier.

use std::path::{Path, PathBuf};

/// Identifiers this app used before, oldest first.
const PREVIOUS: &[&str] = &["dev.firestack.firevoice"];

/// Rename `<base>/<old>` to `<base>/<new>` when only the old one exists. Returns what happened, for the log.
pub fn move_dir(base: &Path, old: &str, new: &str) -> Option<String> {
    let from = base.join(old);
    let to = base.join(new);
    if !from.is_dir() || to.exists() {
        return None;
    }
    // a process that was still closing can hold a file for a moment: try a few times
    let mut last = None;
    for attempt in 0..5 {
        match std::fs::rename(&from, &to) {
            Ok(()) => return Some(format!("moved {} -> {}", from.display(), to.display())),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1)));
            }
        }
    }
    Some(format!("could not move {} -> {}: {}", from.display(), to.display(), last.map(|e| e.to_string()).unwrap_or_default()))
}

fn bases() -> Vec<PathBuf> {
    ["LOCALAPPDATA", "APPDATA"].iter().filter_map(|v| std::env::var_os(v)).map(PathBuf::from).collect()
}

/// Run before the app builds anything. Messages are returned rather than logged: the logger is not up yet.
pub fn previous_identifiers(new: &str) -> Vec<String> {
    let mut out = Vec::new();
    if !cfg!(windows) {
        return out;
    }
    for base in bases() {
        for old in PREVIOUS {
            if let Some(m) = move_dir(&base, old, new) {
                out.push(m);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fv-migrate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn moves_the_old_folder_with_its_contents() {
        let b = tmp("move");
        std::fs::create_dir_all(b.join("old.id/backend/venv")).unwrap();
        std::fs::write(b.join("old.id/backend/installed.json"), "{}").unwrap();
        assert!(move_dir(&b, "old.id", "new.id").unwrap().starts_with("moved"));
        assert!(b.join("new.id/backend/installed.json").exists());
        assert!(!b.join("old.id").exists());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn leaves_an_existing_new_folder_alone() {
        let b = tmp("keep");
        std::fs::create_dir_all(b.join("old.id")).unwrap();
        std::fs::create_dir_all(b.join("new.id")).unwrap();
        std::fs::write(b.join("new.id/mine.txt"), "x").unwrap();
        assert!(move_dir(&b, "old.id", "new.id").is_none());
        assert!(b.join("old.id").exists() && b.join("new.id/mine.txt").exists());
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn nothing_to_do_without_an_old_folder() {
        let b = tmp("none");
        assert!(move_dir(&b, "old.id", "new.id").is_none());
        let _ = std::fs::remove_dir_all(&b);
    }
}
