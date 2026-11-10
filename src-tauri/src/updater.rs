//! App updates, on the user's terms.
//!
//! Releases are published to the public releases repo; each carries a signed installer and `latest.json`, which the
//! configured endpoint (`plugins.updater.endpoints` in tauri.conf.json) points at. Nothing here blocks the app:
//!
//! * `update_check` (at start and every few hours): `none` | `available` | `offline` (the release server could not be
//!   reached; never an error for the user) | `skipped` (a dev build, unless `FIREVOICE_UPDATE_URL` names a test feed).
//! * `update_download` starts the download in the background and returns at once. Progress arrives as
//!   `update-progress` events (a few per second, with the speed), then `update-ready` once the file is downloaded and
//!   its signature checked against the public key built into the app, or `update-failed`.
//! * `update_install` runs only when the user asks for it: it stops the managed voice engine and runs the installer,
//!   which replaces the app and starts the new version.
//! * `update_status` is the whole state at any moment (for a window that opens or reloads part way through).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates {
    /// the update the last check found
    pending: Mutex<Option<Update>>,
    /// where the download is
    state: Mutex<Status>,
    /// the downloaded, verified installer of `state.version`
    bytes: Mutex<Option<Vec<u8>>>,
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

/// The download, as the UI shows it.
#[derive(Serialize, Clone, Default)]
pub struct Status {
    /// "idle" | "downloading" | "ready" | "failed"
    state: String,
    version: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    bytes_per_sec: f64,
    error: Option<String>,
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
            // a newer version than the one already downloaded makes that download stale
            let mut s = lock(&st.state);
            if s.version.as_deref() != Some(u.version.as_str()) && s.state != "downloading" {
                *s = Status { state: "idle".into(), version: Some(u.version.clone()), ..Default::default() };
                *lock(&st.bytes) = None;
            }
            drop(s);
            *lock(&st.pending) = Some(u);
            Ok(out)
        }
        Ok(None) => {
            *lock(&st.pending) = None;
            Ok(base("none", None))
        }
        Err(e) => {
            // no connection, GitHub down, a missing or malformed feed: none of these may get in anyone's way
            log::warn!("update check failed: {e}");
            Ok(base("offline", Some(e.to_string())))
        }
    }
}

#[tauri::command]
pub fn update_status(st: State<'_, Updates>) -> Status {
    lock(&st.state).clone()
}

fn set(app: &AppHandle, f: impl FnOnce(&mut Status)) -> Status {
    let st = app.state::<Updates>();
    let mut s = lock(&st.state);
    f(&mut s);
    s.clone()
}

/// Start downloading the update the last check found. Returns at once; follow the events (or `update_status`).
#[tauri::command]
pub fn update_download(app: AppHandle, st: State<'_, Updates>) -> Result<(), String> {
    let update = lock(&st.pending).clone().ok_or("There is no update to download. Check again.")?;
    {
        let s = lock(&st.state);
        if s.version.as_deref() == Some(update.version.as_str()) && (s.state == "downloading" || s.state == "ready") {
            return Ok(()); // already on its way, or done
        }
    }
    let version = update.version.clone();
    let s = set(&app, |s| *s = Status { state: "downloading".into(), version: Some(version.clone()), ..Default::default() });
    let _ = app.emit("update-progress", s);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut done: u64 = 0;
        let started = Instant::now();
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut speed_at = (Instant::now(), 0u64);
        let mut speed = 0.0f64;
        let progress = app2.clone();
        let result = update
            .download(
                |chunk, total| {
                    done += chunk as u64;
                    let now = Instant::now();
                    let dt = now.duration_since(speed_at.0).as_secs_f64();
                    if dt >= 0.5 {
                        let rate = (done - speed_at.1) as f64 / dt;
                        speed = if speed > 0.0 { 0.6 * speed + 0.4 * rate } else { rate };
                        speed_at = (now, done);
                    }
                    // a few updates a second: one per network chunk floods the window and makes the bar lag and jump
                    if now.duration_since(last_emit).as_millis() >= 150 {
                        last_emit = now;
                        let s = set(&progress, |s| {
                            s.downloaded = done;
                            s.total = total;
                            s.bytes_per_sec = speed;
                        });
                        let _ = progress.emit("update-progress", s);
                    }
                },
                || {},
            )
            .await;
        match result {
            Ok(bytes) => {
                log::info!("update {} downloaded ({} bytes in {:.1}s) and verified", update.version, bytes.len(), started.elapsed().as_secs_f64());
                let total = bytes.len() as u64;
                *lock(&app2.state::<Updates>().bytes) = Some(bytes);
                let s = set(&app2, |s| {
                    s.state = "ready".into();
                    s.downloaded = total;
                    s.total = Some(total);
                    s.bytes_per_sec = 0.0;
                });
                let _ = app2.emit("update-progress", s);
            }
            Err(e) => {
                log::warn!("update download failed: {e}");
                let msg = match e {
                    tauri_plugin_updater::Error::Minisign(_) | tauri_plugin_updater::Error::Base64(_) | tauri_plugin_updater::Error::SignatureUtf8(_) => {
                        "The update did not pass FireVoice's security check, so it was not kept.".to_string()
                    }
                    _ => "The download stopped before it finished. Check your connection and try again.".to_string(),
                };
                let s = set(&app2, |s| {
                    s.state = "failed".into();
                    s.error = Some(msg);
                    s.bytes_per_sec = 0.0;
                });
                let _ = app2.emit("update-progress", s);
            }
        }
    });
    Ok(())
}

/// Install the downloaded update (the user asked for it): the app closes and the new version starts.
#[tauri::command]
pub async fn update_install(app: AppHandle, st: State<'_, Updates>) -> Result<(), String> {
    let update = lock(&st.pending).clone().ok_or("There is no update to install. Check again.")?;
    let ready = lock(&st.state).state == "ready" && lock(&st.state).version.as_deref() == Some(update.version.as_str());
    let bytes = if ready { lock(&st.bytes).clone() } else { None };
    let bytes = bytes.ok_or("The update has not finished downloading yet.")?;
    // the installer replaces files the app uses: stop the voice engine (and its workers) first
    crate::backend::stop_setup(&app.state::<crate::backend::Backend>());
    crate::backend::stop(&app.state::<crate::backend::Backend>());
    log::info!("installing update {}", update.version);
    update.install(bytes).map_err(|e| {
        log::error!("update install failed: {e}");
        "The update could not be installed. Try again, or download it from the FireVoice releases page.".to_string()
    })?;
    // Windows: the installer has taken over and starts the new version itself. Elsewhere, restart into it.
    app.restart();
}
