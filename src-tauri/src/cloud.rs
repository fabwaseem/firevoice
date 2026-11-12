//! FireVoice cloud: the optional link between this install and firevoice.fabwaseem.com.
//!
//! - Usage sharing (asked on first launch, a switch in Settings): the install registers once and gets its own token,
//!   then sends what the app does in batches (`track`): launches, time in use, dictations (word counts, the program,
//!   never the words), pages opened, features used, plus crash reports. Until the person answers, events wait here;
//!   if they say no, they are dropped and nothing is ever sent.
//! - Accounts: sign up, sign in and out, change details, delete. The session token stays in this process (and the
//!   app's config folder); the window only ever sees the account's public details.
//! - Feedback, and the licence check (licences are off while FireVoice is free).
//!
//! Everything goes over HTTPS with the same client the updater uses. Nothing here blocks the app: requests run on the
//! async runtime, and if the server is unreachable the events wait (up to 2,000, kept across restarts).

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const DEFAULT_URL: &str = "https://firevoice.fabwaseem.com";
const MAX_QUEUE: usize = 2000;
const BATCH: usize = 200;
const FLUSH_EVERY: Duration = Duration::from_secs(60);
const HEARTBEAT_EVERY: u64 = 5; // flush rounds (5 minutes)

/// What is kept between runs (cloud.json in the app's config folder).
#[derive(Default, Clone, Serialize, Deserialize)]
struct Saved {
    /// None until the person answers the first-launch question
    consent: Option<bool>,
    install_id: Option<String>,
    token: Option<String>,
    session: Option<String>,
    user: Option<Value>,
    /// the app version (and details) last told to the server, so a change is sent once
    reported: Option<String>,
    /// what only the window knows: language, time zone, screen, graphics card
    extra: Map<String, Value>,
}

pub struct Cloud {
    saved: Mutex<Saved>,
    queue: Mutex<Vec<Value>>,
    /// this run of the app, so events can be grouped into sessions
    run: String,
    http: reqwest::Client,
    base: String,
    busy: AtomicBool,
}

impl Default for Cloud {
    fn default() -> Self {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(8))
            .user_agent(format!("FireVoice/{} ({})", env!("CARGO_PKG_VERSION"), std::env::consts::OS))
            .https_only(!cfg!(debug_assertions))
            .build()
            .unwrap_or_default();
        // a development build can point at a local site: FIREVOICE_CLOUD_URL=http://localhost:3000
        let base = std::env::var("FIREVOICE_CLOUD_URL")
            .ok()
            .filter(|u| cfg!(debug_assertions) && (u.starts_with("http://") || u.starts_with("https://")))
            .unwrap_or_else(|| DEFAULT_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        Cloud {
            saved: Mutex::new(Saved::default()),
            queue: Mutex::new(Vec::new()),
            run: random_id(),
            http,
            base,
            busy: AtomicBool::new(false),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn random_id() -> String {
    let mut h = Sha256::new();
    h.update(format!("{:?}{}{:?}", std::time::SystemTime::now(), std::process::id(), std::thread::current().id()));
    hex(&h.finalize())[..16].to_string()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn now_iso() -> String {
    // RFC 3339 in UTC without a date library: seconds since the epoch, broken into a calendar date
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

fn save(app: &AppHandle) {
    let st = app.state::<Cloud>();
    let saved = lock(&st.saved).clone();
    if let Some(p) = file(app, "cloud.json") {
        let _ = std::fs::create_dir_all(p.parent().unwrap_or(&p));
        let _ = std::fs::write(&p, serde_json::to_vec_pretty(&saved).unwrap_or_default());
    }
}

/// Keeps unsent events for the next run (called as the app quits).
pub fn save_queue(app: &AppHandle) {
    let st = app.state::<Cloud>();
    let q = lock(&st.queue).clone();
    if let Some(p) = file(app, "cloud-queue.json") {
        if q.is_empty() || lock(&st.saved).consent == Some(false) {
            let _ = std::fs::remove_file(p);
        } else {
            let _ = std::fs::write(p, serde_json::to_vec(&q).unwrap_or_default());
        }
    }
}

// ---------------------------------------------------------------- the computer

#[cfg(windows)]
fn reg_string(key: &str, name: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (k, n) = (wide(key), wide(name));
    let mut buf = vec![0u16; 512];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: the buffers are valid and sized; RegGetValueW writes at most `size` bytes
    let r = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, k.as_ptr(), n.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut size)
    };
    if r != 0 {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buf[..len.min(buf.len())]).trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(not(windows))]
fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// A one-way hash of the machine's own id: the same computer gets the same value after a reinstall, and the id itself
/// never leaves it.
fn device_id() -> String {
    #[cfg(windows)]
    let raw = reg_string("SOFTWARE\\Microsoft\\Cryptography", "MachineGuid");
    #[cfg(not(windows))]
    let raw = read("/etc/machine-id").or_else(|| read("/var/lib/dbus/machine-id"));
    let mut h = Sha256::new();
    h.update(b"firevoice-device:");
    h.update(raw.unwrap_or_else(random_id).as_bytes());
    hex(&h.finalize())
}

fn ram_gb() -> Option<f64> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        // SAFETY: a zeroed struct with its length set, as the API requires
        let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut m) } != 0 {
            return Some((m.ullTotalPhys as f64 / 1_073_741_824.0 * 10.0).round() / 10.0);
        }
        None
    }
    #[cfg(not(windows))]
    {
        let kb = read("/proc/meminfo")?.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse::<f64>().ok()?;
        Some((kb / 1_048_576.0 * 10.0).round() / 10.0)
    }
}

fn device(app: &AppHandle, extra: &Map<String, Value>) -> Value {
    #[cfg(windows)]
    let (os, os_version, cpu, host) = {
        let cv = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
        let build = reg_string(cv, "CurrentBuild").unwrap_or_default();
        // Windows 11 still says "Windows 10" in ProductName; the build tells them apart
        let name = if build.parse::<u32>().unwrap_or(0) >= 22_000 { "11" } else { "10" };
        let display = reg_string(cv, "DisplayVersion").unwrap_or_default();
        (
            "windows",
            format!("{name} {display} ({build})").trim().to_string(),
            reg_string("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", "ProcessorNameString"),
            std::env::var("COMPUTERNAME").ok(),
        )
    };
    #[cfg(target_os = "linux")]
    let (os, os_version, cpu, host) = (
        "linux",
        read("/etc/os-release")
            .and_then(|s| s.lines().find(|l| l.starts_with("PRETTY_NAME=")).map(|l| l[12..].trim_matches('"').to_string()))
            .unwrap_or_default(),
        read("/proc/cpuinfo").and_then(|s| s.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split(':').nth(1)).map(|v| v.trim().to_string())),
        read("/etc/hostname"),
    );
    #[cfg(target_os = "macos")]
    let (os, os_version, cpu, host): (&str, String, Option<String>, Option<String>) = ("macos", String::new(), None, None);

    let mut d = json!({
        "appVersion": app.package_info().version.to_string(),
        "channel": if cfg!(debug_assertions) { "dev" } else { "stable" },
        "os": os,
        "osVersion": os_version,
        "arch": std::env::consts::ARCH,
        "cpu": cpu,
        "cores": std::thread::available_parallelism().map(|n| n.get() as u64).ok(),
        "ramGb": ram_gb(),
        "hostname": host,
    });
    for k in ["locale", "timezone", "screen", "gpu"] {
        if let Some(v) = extra.get(k) {
            d[k] = v.clone();
        }
    }
    d
}

// ---------------------------------------------------------------- talking to the server

#[derive(Debug)]
pub struct Failure {
    pub status: u16,
    pub code: String,
    pub message: String,
}

impl From<Failure> for String {
    fn from(f: Failure) -> String {
        f.message
    }
}

async fn call(app: &AppHandle, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, Failure> {
    let st = app.state::<Cloud>();
    let (token, session) = {
        let s = lock(&st.saved);
        (s.token.clone(), s.session.clone())
    };
    let mut req = st.http.request(method, format!("{}{}", st.base, path));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(s) = session {
        req = req.header("X-FireVoice-Session", s);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| Failure {
        status: 0,
        code: "offline".into(),
        message: if e.is_timeout() { "FireVoice's server did not answer in time. Try again.".into() } else { "Could not reach FireVoice's server. Check your internet connection.".into() },
    })?;
    let status = res.status().as_u16();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        return Ok(data);
    }
    let code = data["error"].as_str().unwrap_or("error").to_string();
    // the install's token is no longer known (erased on the server): forget it, register again next time
    if status == 401 && path != "/api/v1/auth/login" {
        let mut s = lock(&st.saved);
        if code == "unauthorized" {
            s.token = None;
            s.install_id = None;
        } else if code == "signed_out" {
            s.session = None;
            s.user = None;
        }
    }
    Err(Failure { status, code, message: data["message"].as_str().unwrap_or("Something went wrong.").to_string() })
}

fn sharing(app: &AppHandle) -> bool {
    lock(&app.state::<Cloud>().saved).consent == Some(true)
}

/// Registers the install (once), or tells the server what changed (a new version, a new graphics card).
async fn ensure_registered(app: &AppHandle) -> bool {
    if !sharing(app) {
        return false;
    }
    let st = app.state::<Cloud>();
    let (has_token, reported, extra) = {
        let s = lock(&st.saved);
        (s.token.is_some(), s.reported.clone(), s.extra.clone())
    };
    let info = device(app, &extra);
    let fingerprint = info.to_string();
    if !has_token {
        let mut body = info.clone();
        body["deviceId"] = json!(device_id());
        body["consent"] = json!(true);
        match call(app, reqwest::Method::POST, "/api/v1/installs", Some(body)).await {
            Ok(r) => {
                let mut s = lock(&st.saved);
                s.token = r["token"].as_str().map(String::from);
                s.install_id = r["installId"].as_str().map(String::from);
                s.reported = Some(fingerprint);
                drop(s);
                save(app);
                log::info!("cloud: install registered");
                true
            }
            Err(e) => {
                log::debug!("cloud: register failed: {}", e.message);
                false
            }
        }
    } else {
        if reported.as_deref() != Some(&fingerprint) && call(app, reqwest::Method::PATCH, "/api/v1/installs/me", Some(info)).await.is_ok() {
            lock(&st.saved).reported = Some(fingerprint);
            save(app);
        }
        lock(&st.saved).token.is_some()
    }
}

/// Sends what is waiting, a batch at a time; keeps it when the server cannot be reached.
async fn flush(app: &AppHandle) {
    let st = app.state::<Cloud>();
    if st.busy.swap(true, Ordering::AcqRel) {
        return;
    }
    if ensure_registered(app).await {
        send_crash(app).await;
        loop {
            let batch: Vec<Value> = lock(&st.queue).iter().take(BATCH).cloned().collect();
            if batch.is_empty() {
                break;
            }
            let n = batch.len();
            match call(app, reqwest::Method::POST, "/api/v1/events", Some(json!({ "events": batch }))).await {
                Ok(_) => {
                    let mut q = lock(&st.queue);
                    let n = n.min(q.len());
                    q.drain(..n);
                }
                // a batch the server refuses as invalid would be refused forever: drop it
                Err(f) if f.status == 400 || f.status == 413 => {
                    log::warn!("cloud: events refused ({}), dropped", f.message);
                    let mut q = lock(&st.queue);
                    let n = n.min(q.len());
                    q.drain(..n);
                }
                Err(_) => break,
            }
        }
    }
    st.busy.store(false, Ordering::Release);
}

/// Something the app did. Waits in the queue; sent within a minute when sharing is on, never when it is off.
pub fn track(app: &AppHandle, name: &str, props: Value) {
    let st = app.state::<Cloud>();
    if lock(&st.saved).consent == Some(false) {
        return;
    }
    let mut ev = json!({ "name": name, "at": now_iso(), "session": st.run });
    if props.is_object() && !props.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        ev["props"] = props;
    }
    let mut q = lock(&st.queue);
    if q.len() >= MAX_QUEUE {
        q.remove(0);
    }
    q.push(ev);
}

// ---------------------------------------------------------------- crashes

/// A panic is written to a file at once (the release build aborts right after) and sent on the next run.
fn crash_hook(app: &AppHandle) {
    let Some(path) = file(app, "cloud-crash.json") else { return };
    let version = app.package_info().version.to_string();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let report = json!({ "kind": "panic", "message": msg.chars().take(1900).collect::<String>(), "stack": format!("at {at}\n{}", std::backtrace::Backtrace::force_capture()).chars().take(19_000).collect::<String>(), "context": { "version": version } });
        let _ = std::fs::write(&path, report.to_string());
        previous(info);
    }));
}

async fn send_crash(app: &AppHandle) {
    let Some(path) = file(app, "cloud-crash.json") else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let report: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if report.is_object() {
        let r = call(app, reqwest::Method::POST, "/api/v1/crashes", Some(report)).await;
        if matches!(&r, Err(f) if f.status == 0) {
            return; // offline: try again next time
        }
    }
    let _ = std::fs::remove_file(path);
}

/// Reports an error from the window or the engine (with sharing on).
pub fn report_error(app: &AppHandle, kind: &str, message: &str, stack: Option<&str>) {
    if !sharing(app) {
        return;
    }
    let body = json!({ "kind": kind, "message": message.chars().take(1900).collect::<String>(), "stack": stack.map(|s| s.chars().take(19_000).collect::<String>()) });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if ensure_registered(&app).await {
            let _ = call(&app, reqwest::Method::POST, "/api/v1/crashes", Some(body)).await;
        }
    });
}

// ---------------------------------------------------------------- start

/// Loads what was saved, counts the launch, and sends in the background every minute (with a heartbeat every five).
pub fn start(app: &AppHandle) {
    crash_hook(app);
    let st = app.state::<Cloud>();
    if let Some(p) = file(app, "cloud.json") {
        if let Ok(b) = std::fs::read(&p) {
            *lock(&st.saved) = serde_json::from_slice(&b).unwrap_or_default();
        }
    }
    if let Some(p) = file(app, "cloud-queue.json") {
        if let Ok(b) = std::fs::read(&p) {
            let old: Vec<Value> = serde_json::from_slice(&b).unwrap_or_default();
            lock(&st.queue).extend(old.into_iter().take(MAX_QUEUE));
        }
        let _ = std::fs::remove_file(p);
    }
    track(app, "app.launch", json!({ "atLogin": crate::autostart::started_at_login() }));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // a little after start, so the app's own work goes first
        tokio::time::sleep(Duration::from_secs(8)).await;
        let mut round: u64 = 0;
        loop {
            flush(&app).await;
            tokio::time::sleep(FLUSH_EVERY).await;
            round += 1;
            if round % HEARTBEAT_EVERY == 0 {
                track(&app, "app.heartbeat", json!({ "seconds": FLUSH_EVERY.as_secs() * HEARTBEAT_EVERY }));
            }
        }
    });
}

// ---------------------------------------------------------------- commands for the window

fn status_value(app: &AppHandle) -> Value {
    let st = app.state::<Cloud>();
    let s = lock(&st.saved);
    json!({
        "consent": s.consent,
        "registered": s.token.is_some(),
        "installId": s.install_id,
        "signedIn": s.session.is_some(),
        "user": s.user,
        "server": st.base,
        "queued": lock(&st.queue).len(),
    })
}

#[tauri::command]
pub fn cloud_status(app: AppHandle) -> Value {
    status_value(&app)
}

/// What only the window knows (language, time zone, screen, graphics card): sent with the install's details.
#[tauri::command]
pub fn cloud_hello(app: AppHandle, info: Map<String, Value>) {
    let st = app.state::<Cloud>();
    {
        let mut s = lock(&st.saved);
        for k in ["locale", "timezone", "screen", "gpu"] {
            if let Some(v) = info.get(k).filter(|v| v.is_string() && v.as_str().map(|s| s.len() <= 160).unwrap_or(false)) {
                s.extra.insert(k.into(), v.clone());
            }
        }
    }
    save(&app);
}

/// The answer to "share usage?", from the first-launch question or the Settings switch.
#[tauri::command]
pub async fn cloud_consent(app: AppHandle, on: bool) -> Result<Value, String> {
    let st = app.state::<Cloud>();
    let was_registered = {
        let mut s = lock(&st.saved);
        s.consent = Some(on);
        s.token.is_some()
    };
    if !on {
        lock(&st.queue).clear();
    }
    save(&app);
    if on {
        let a = app.clone();
        tauri::async_runtime::spawn(async move { flush(&a).await });
    } else if was_registered {
        // tell the server to stop keeping anything new from this install
        let _ = call(&app, reqwest::Method::PATCH, "/api/v1/installs/me", Some(json!({ "consent": false }))).await;
    }
    Ok(status_value(&app))
}

#[tauri::command]
pub fn cloud_track(app: AppHandle, name: String, props: Option<Value>) {
    let ok = name.len() <= 64 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_');
    if ok {
        track(&app, &name, props.unwrap_or(Value::Null));
    }
}

#[tauri::command]
pub fn cloud_error(app: AppHandle, message: String, stack: Option<String>) {
    report_error(&app, "ui", &message, stack.as_deref());
}

/// Erase everything this install sent, and stop sharing.
#[tauri::command]
pub async fn cloud_erase(app: AppHandle) -> Result<Value, String> {
    let st = app.state::<Cloud>();
    if lock(&st.saved).token.is_some() {
        call(&app, reqwest::Method::DELETE, "/api/v1/installs/me", None).await?;
    }
    {
        let mut s = lock(&st.saved);
        s.consent = Some(false);
        s.token = None;
        s.install_id = None;
        s.reported = None;
    }
    lock(&st.queue).clear();
    save(&app);
    Ok(status_value(&app))
}

fn signed_in(app: &AppHandle, r: &Value) -> Value {
    let st = app.state::<Cloud>();
    {
        let mut s = lock(&st.saved);
        s.session = r["token"].as_str().map(String::from);
        s.user = Some(r["user"].clone());
    }
    save(app);
    status_value(app)
}

/// Sign up or sign in. Registers the install first (with sharing on) so the account and install are linked.
#[tauri::command]
pub async fn cloud_sign_in(app: AppHandle, action: String, email: String, password: String, name: Option<String>) -> Result<Value, String> {
    ensure_registered(&app).await;
    let (path, body) = match action.as_str() {
        "signup" => ("/api/v1/auth/signup", json!({ "email": email, "password": password, "name": name })),
        "login" => ("/api/v1/auth/login", json!({ "email": email, "password": password })),
        _ => return Err("Unknown action.".into()),
    };
    let r = call(&app, reqwest::Method::POST, path, Some(body)).await?;
    track(&app, if action == "signup" { "account.signup" } else { "account.login" }, Value::Null);
    Ok(signed_in(&app, &r))
}

#[tauri::command]
pub async fn cloud_sign_out(app: AppHandle) -> Result<Value, String> {
    let _ = call(&app, reqwest::Method::POST, "/api/v1/auth/logout", None).await;
    {
        let st = app.state::<Cloud>();
        let mut s = lock(&st.saved);
        s.session = None;
        s.user = None;
    }
    save(&app);
    Ok(status_value(&app))
}

/// The account, fresh from the server (and whether it is still signed in).
#[tauri::command]
pub async fn cloud_me(app: AppHandle) -> Result<Value, String> {
    if lock(&app.state::<Cloud>().saved).session.is_none() {
        return Ok(status_value(&app));
    }
    match call(&app, reqwest::Method::GET, "/api/v1/auth/me", None).await {
        Ok(r) => {
            lock(&app.state::<Cloud>().saved).user = Some(r["user"].clone());
            save(&app);
            let mut v = status_value(&app);
            v["installs"] = r["installs"].clone();
            Ok(v)
        }
        // offline: what is known locally
        Err(f) if f.status == 0 => Ok(status_value(&app)),
        Err(_) => {
            save(&app);
            Ok(status_value(&app))
        }
    }
}

/// Change the name or password (body: name, currentPassword, newPassword).
#[tauri::command]
pub async fn cloud_update_account(app: AppHandle, body: Value) -> Result<Value, String> {
    let r = call(&app, reqwest::Method::PATCH, "/api/v1/auth/me", Some(body)).await?;
    lock(&app.state::<Cloud>().saved).user = Some(r["user"].clone());
    save(&app);
    Ok(status_value(&app))
}

#[tauri::command]
pub async fn cloud_delete_account(app: AppHandle, password: String) -> Result<Value, String> {
    call(&app, reqwest::Method::DELETE, "/api/v1/auth/me", Some(json!({ "password": password }))).await?;
    {
        let st = app.state::<Cloud>();
        let mut s = lock(&st.saved);
        s.session = None;
        s.user = None;
    }
    save(&app);
    Ok(status_value(&app))
}

#[tauri::command]
pub async fn cloud_resend(app: AppHandle) -> Result<(), String> {
    call(&app, reqwest::Method::POST, "/api/v1/auth/resend", None).await?;
    Ok(())
}

#[tauri::command]
pub async fn cloud_forgot(app: AppHandle, email: String) -> Result<(), String> {
    call(&app, reqwest::Method::POST, "/api/v1/auth/forgot", Some(json!({ "email": email }))).await?;
    Ok(())
}

/// Feedback from the app: sent with this install (and the account, when signed in).
#[tauri::command]
pub async fn cloud_feedback(app: AppHandle, kind: String, message: String, email: Option<String>, rating: Option<u8>) -> Result<(), String> {
    if sharing(&app) {
        ensure_registered(&app).await;
    }
    let body = json!({ "kind": kind, "message": message, "email": email.unwrap_or_default(), "rating": rating, "context": { "version": app.package_info().version.to_string() } });
    call(&app, reqwest::Method::POST, "/api/v1/feedback", Some(body)).await?;
    Ok(())
}

/// The plan: { licensing: false, plan: "free" } while FireVoice is free.
#[tauri::command]
pub async fn cloud_license(app: AppHandle) -> Result<Value, String> {
    match call(&app, reqwest::Method::GET, "/api/v1/license", None).await {
        Ok(v) => Ok(v),
        Err(f) if f.status == 0 => Ok(json!({ "licensing": false, "plan": "free", "offline": true })),
        Err(f) => Err(f.message),
    }
}

#[tauri::command]
pub async fn cloud_activate(app: AppHandle, key: String) -> Result<Value, String> {
    if !ensure_registered(&app).await {
        return Err("Turn on usage sharing in Settings to activate a key on this computer.".into());
    }
    Ok(call(&app, reqwest::Method::POST, "/api/v1/license/activate", Some(json!({ "key": key }))).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_time_looks_right() {
        let t = now_iso();
        assert_eq!(t.len(), 20);
        assert!(t.ends_with('Z') && t.as_bytes()[10] == b'T');
        assert!(t.starts_with("20"));
    }

    #[test]
    fn device_id_is_a_stable_hash() {
        let a = device_id();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a, device_id());
    }
}
