//! Required updates.
//!
//! Releases are published to the public releases repo (see `scripts/release.mjs`); each carries a signed NSIS
//! installer and `latest.json`, which the configured endpoint (`plugins.updater.endpoints` in tauri.conf.json) points
//! at. The UI calls `update_check` at start and every few hours:
//!
//! * `none`: this is the newest version;
//! * `available`: a newer version exists, and the app shows nothing but the update screen until it is installed;
//! * `offline`: the release server could not be reached or answered something unusable. The app opens normally: an
//!   update is only required when it can actually be fetched.
//! * `skipped`: a dev build (updates apply to installed builds only), unless `FIREVOICE_UPDATE_URL` points the check at
//!   a test feed.
//!
//! `update_install` downloads with `update-progress` events, verifies the signature against the public key built into
//! the app, stops the managed voice engine, and runs the installer, which replaces the app and starts the new version.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
}

#[derive(Serialize, Clone)]
pub struct UpdateCheck {
    /// "none" | "available" | "offline" | "skipped"
    status: &'static str,
    current: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
    /// why a check counted as offline (for the log; not shown as an error)
    reason: Option<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn test_feed() -> Option<String> {
    std::env::var("FIREVOICE_UPDATE_URL").ok().filter(|s| !s.trim().is_empty())
}

#[tauri::command]
pub async fn update_check(app: AppHandle, st: State<'_, Updates>) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let base = |status, reason: Option<String>| UpdateCheck { status, current: current.clone(), version: None, notes: None, date: None, reason };
    let feed = test_feed();
    if cfg!(debug_assertions) && feed.is_none() {
        return Ok(base("skipped", None));
    }
    let mut builder = app.updater_builder().timeout(Duration::from_secs(20));
    if let Some(url) = feed {
        let url = url.parse().map_err(|e| format!("FIREVOICE_UPDATE_URL: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = match builder.build() {
        Ok(u) => u,
        Err(e) => return Ok(base("offline", Some(e.to_string()))),
    };
    match updater.check().await {
        Ok(Some(u)) => {
            let out = UpdateCheck {
                status: "available",
                current: current.clone(),
                version: Some(u.version.clone()),
                notes: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
                reason: None,
            };
            log::info!("update {} -> {} available", current, u.version);
            *lock(&st.pending) = Some(u);
            Ok(out)
        }
        Ok(None) => {
            *lock(&st.pending) = None;
            Ok(base("none", None))
        }
        Err(e) => {
            // no connection, GitHub down, a missing or malformed feed: none of these may lock anyone out
            log::warn!("update check failed, opening normally: {e}");
            Ok(base("offline", Some(e.to_string())))
        }
    }
}

#[tauri::command]
pub async fn update_install(app: AppHandle, st: State<'_, Updates>) -> Result<(), String> {
    let update = lock(&st.pending).clone().ok_or("There is no update to install. Check again.")?;
    let mut done: u64 = 0;
    let progress = app.clone();
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                let _ = progress.emit("update-progress", Progress { downloaded: done, total });
            },
            || {},
        )
        .await
        .map_err(|e| {
            log::warn!("update download failed: {e}");
            match e {
                tauri_plugin_updater::Error::Minisign(_) | tauri_plugin_updater::Error::Base64(_) | tauri_plugin_updater::Error::SignatureUtf8(_) =>
                    "The update did not pass FireVoice's security check, so it was not installed.".to_string(),
                _ => "The download stopped before it finished. Check your connection and try again.".to_string(),
            }
        })?;
    // the installer replaces files the app uses: stop the voice engine (and its workers) first
    crate::backend::stop(&app.state::<crate::backend::Backend>());
    log::info!("installing update {}", update.version);
    update.install(bytes).map_err(|e| {
        log::error!("update install failed: {e}");
        "The update downloaded but could not be installed. Try again, or download it from the FireVoice releases page.".to_string()
    })?;
    // Windows: the installer has taken over and starts the new version itself. Elsewhere, restart into it.
    app.restart();
}
