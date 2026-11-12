//! The FireVoice backend as a managed sidecar.
//!
//! The backend is a standalone Python service (the FireVoice HTTP API); the app never depends on it being started by the
//! app, and the app works against any running FireVoice server. When the user lets the app manage it, this module:
//!
//! * finds the Python that runs it, in this order: `FIREVOICE_BACKEND_PYTHON`; the bundled runtime (built on first
//!   run from the wheel, uv and recipe that the desktop build copies into `resources/backend/`); in debug builds, the
//!   repo's `backend/.venv` (linked by `scripts/dev-setup.mjs`, running the code in `backend/`);
//! * builds the bundled runtime with uv in two phases, so a new user is in the app within about a minute:
//!   - **core** (`backend_setup`, the user waits): a private Python 3.12 venv in the app's local data folder and the
//!     backend wheel with only what the server needs to start (`core_extras`), every version taken from the pinned
//!     `constraints.txt`. Progress goes out as `backend-setup` events.
//!   - **the rest** (`backend_finish_setup`, in the background while the server runs): torch and torchaudio, downloaded
//!     by `fetch_wheels.py` with byte-exact progress and resume, then every other pinned package. Because all versions
//!     were fixed up front this only adds packages and never replaces one the running server holds open. Progress goes
//!     out as `backend-extras` events, and `backend_extras_status` returns the latest state.
//!   An update of the app (a new backend version, when the runtime was already complete) reinstalls the backend and
//!   brings the other packages in step before the server starts, so nothing changes under a running server.
//! * starts the server (`firevoice.server`) with its output in the app log folder, and stops it (with its engine
//!   worker processes) on request and when the app exits.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The downloader for the big wheels, run inside the runtime's own Python.
const FETCH_WHEELS: &str = include_str!("fetch_wheels.py");

#[derive(Default)]
pub struct Backend {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    setup_running: Mutex<bool>,
    extras_running: Mutex<bool>,
    extras: Mutex<Extras>,
    /// The setup command running now (uv, the downloader), so quitting the app stops it too.
    task_pid: Mutex<Option<u32>>,
}

/// What the desktop build bundles next to the wheel (`resources/backend/backend.json`).
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Recipe {
    pub version: String,
    pub api_version: u32,
    pub python: String,
    pub wheel: String,
    pub extras: Vec<String>,
    pub torch: String,
    pub torch_index: String,
    /// Versions forced over what dependencies ask for (uv --override), e.g. a newer CUDA torch than a pin allows.
    #[serde(default)]
    pub overrides: Vec<String>,
    /// The extras that are enough to start the server; empty in builds from before the two-phase setup.
    #[serde(default)]
    pub core_extras: Vec<String>,
    /// Every package of the full runtime, pinned (a file next to backend.json).
    #[serde(default)]
    pub constraints: Option<String>,
    /// No NVIDIA card here: torch comes from the CPU index (set when the recipe is read, never in backend.json).
    #[serde(skip)]
    pub cpu: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Installed {
    version: String,
    wheel: String,
    /// Everything is installed, not just the core (runtimes from before the two-phase setup always were).
    #[serde(default = "yes")]
    full: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Clone, Debug)]
pub struct BackendInfo {
    /// "custom" (FIREVOICE_BACKEND_PYTHON), "bundled", "dev" (sibling checkout) or "none"
    mode: String,
    python: Option<String>,
    /// The Python exists and, for the bundled runtime, matches the bundled version (the server can start).
    ready: bool,
    /// Everything is installed, torch included (always true outside the bundled runtime).
    full_ready: bool,
    bundled_version: Option<String>,
    bundled_api_version: Option<u32>,
    installed_version: Option<String>,
    running: bool,
    pid: Option<u32>,
    port: Option<u16>,
    log_path: String,
    runtime_dir: String,
    setup_running: bool,
    extras_running: bool,
    /// No NVIDIA card: the runtime is the small CPU build, and the setup is much smaller.
    cpu_only: bool,
}

#[derive(Serialize, Clone, Debug)]
struct SetupEvent {
    step: u32,
    steps: u32,
    message: String,
    status: String, // running | done | failed
    error: Option<String>,
}

/// One thing the background setup fetches or does.
#[derive(Serialize, Clone, Debug)]
struct ExtrasItem {
    id: String,
    label: String,
    done: u64,
    total: u64,
    state: String, // waiting | active | done
}

/// The background setup, as the UI shows it.
#[derive(Serialize, Clone, Debug, Default)]
pub struct Extras {
    status: String, // idle | running | done | failed
    stage: String,  // download | install | check
    message: String,
    error: Option<String>,
    items: Vec<ExtrasItem>,
    done_bytes: u64,
    total_bytes: u64,
    bytes_per_sec: f64,
    /// 0..1 over the whole background setup
    progress: f64,
    /// how far the install stage is (0..1)
    #[serde(skip)]
    install: f64,
    /// sizes uv announced for the downloads it has not finished yet
    #[serde(skip)]
    pending: std::collections::HashMap<String, u64>,
    #[serde(skip)]
    speed_at: Option<(Instant, u64)>,
    #[serde(skip)]
    emitted: Option<Instant>,
}

/// Lock a mutex, recovering the data if a thread panicked while holding it (the state stays usable).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) { venv.join("Scripts").join("python.exe") } else { venv.join("bin").join("python") }
}

fn resources_dir(app: &AppHandle) -> Option<PathBuf> {
    let d = app.path().resource_dir().ok()?.join("backend");
    d.join("backend.json").exists().then_some(d)
}

fn recipe(app: &AppHandle) -> Option<Recipe> {
    let d = resources_dir(app)?;
    let mut r: Recipe = serde_json::from_str(&fs::read_to_string(d.join("backend.json")).ok()?).ok()?;
    if !has_nvidia() {
        r.torch_index = cpu_index(&r.torch_index);
        r.cpu = true;
    }
    Some(r)
}

/// Whether this computer has an NVIDIA graphics card with its driver (what the CUDA build of torch needs). Any other
/// computer (an AMD or Intel card, or none) gets the CPU build, which is a few hundred MB instead of several GB.
/// FIREVOICE_ACCELERATOR=cpu|cuda overrides the check (for testing).
fn has_nvidia() -> bool {
    static FOUND: OnceLock<bool> = OnceLock::new();
    *FOUND.get_or_init(|| {
        match std::env::var("FIREVOICE_ACCELERATOR").ok().as_deref() {
            Some("cpu") => return false,
            Some("cuda") => return true,
            _ => {}
        }
        let mut c = Command::new("nvidia-smi");
        c.arg("-L").stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        c.output().map(|o| o.status.success() && !o.stdout.is_empty()).unwrap_or(false)
    })
}

/// The CPU index next to a CUDA one: https://download.pytorch.org/whl/cu128 -> https://download.pytorch.org/whl/cpu
fn cpu_index(cuda: &str) -> String {
    match cuda.trim_end_matches('/').rsplit_once('/') {
        Some((base, _)) => format!("{base}/cpu"),
        None => cuda.to_string(),
    }
}

fn runtime_dir(app: &AppHandle) -> PathBuf {
    // FIREVOICE_RUNTIME_DIR builds the runtime somewhere else (to try a first run without touching the real one)
    if let Some(d) = std::env::var_os("FIREVOICE_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("FireVoice")).join("backend")
}

/// Where the big wheels are downloaded to (engine installs reuse them: the server gets it as FIREVOICE_WHEELS).
fn wheels_dir(app: &AppHandle) -> PathBuf {
    runtime_dir(app).join("wheels")
}

fn installed(app: &AppHandle) -> Option<Installed> {
    serde_json::from_str(&fs::read_to_string(runtime_dir(app).join("installed.json")).ok()?).ok()
}

fn write_installed(app: &AppHandle, i: &Installed) -> Result<(), String> {
    let s = serde_json::to_string_pretty(i).map_err(|e| e.to_string())?;
    fs::write(runtime_dir(app).join("installed.json"), s).map_err(|e| e.to_string())
}

fn log_path(app: &AppHandle) -> PathBuf {
    let d = app.path().app_log_dir().unwrap_or_else(|_| runtime_dir(app));
    let _ = fs::create_dir_all(&d);
    d.join("backend.log")
}

fn dev_python() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    // src-tauri/ -> repo root -> backend/.venv (a link to the dev resources folder; see scripts/dev-setup.mjs)
    let p = venv_python(&Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("backend").join(".venv"));
    p.exists().then_some(p)
}

/// (mode, python, ready, full_ready)
fn resolve(app: &AppHandle) -> (String, Option<PathBuf>, bool, bool) {
    if let Ok(p) = std::env::var("FIREVOICE_BACKEND_PYTHON") {
        let p = PathBuf::from(p);
        let ok = p.exists();
        return ("custom".into(), Some(p), ok, ok);
    }
    // `tauri dev` copies the staged resources too: in a debug build the source checkout wins, unless
    // FIREVOICE_DESKTOP_BUNDLED=1 asks to exercise the bundled runtime.
    let prefer_bundled = std::env::var("FIREVOICE_DESKTOP_BUNDLED").is_ok_and(|v| v == "1");
    if !prefer_bundled {
        if let Some(p) = dev_python() {
            return ("dev".into(), Some(p), true, true);
        }
    }
    if let Some(r) = recipe(app) {
        let py = venv_python(&runtime_dir(app).join("venv"));
        let inst = installed(app).filter(|i| i.version == r.version && i.wheel == r.wheel);
        let ok = py.exists() && inst.is_some();
        return ("bundled".into(), Some(py), ok, ok && inst.is_some_and(|i| i.full));
    }
    ("none".into(), None, false, false)
}

fn alive(child: &mut Option<Child>) -> bool {
    match child {
        Some(c) => match c.try_wait() {
            Ok(None) => true,
            _ => {
                *child = None;
                false
            }
        },
        None => false,
    }
}

fn info(app: &AppHandle, st: &Backend) -> BackendInfo {
    let (mode, python, ready, full_ready) = resolve(app);
    let mut child = lock(&st.child);
    let running = alive(&mut child);
    let r = recipe(app);
    BackendInfo {
        mode,
        python: python.map(|p| p.display().to_string()),
        ready,
        full_ready,
        bundled_version: r.as_ref().map(|r| r.version.clone()),
        bundled_api_version: r.as_ref().map(|r| r.api_version),
        installed_version: installed(app).map(|i| i.version),
        running,
        pid: child.as_ref().map(|c| c.id()),
        port: if running { *lock(&st.port) } else { None },
        log_path: log_path(app).display().to_string(),
        runtime_dir: runtime_dir(app).display().to_string(),
        setup_running: *lock(&st.setup_running),
        extras_running: *lock(&st.extras_running),
        cpu_only: r.as_ref().is_some_and(|r| r.cpu),
    }
}

#[tauri::command]
pub fn backend_info(app: AppHandle, st: State<Backend>) -> BackendInfo {
    info(&app, &st)
}

#[tauri::command]
pub fn backend_start(app: AppHandle, st: State<Backend>, port: Option<u16>) -> Result<BackendInfo, String> {
    {
        let mut child = lock(&st.child);
        if alive(&mut child) {
            drop(child);
            return Ok(info(&app, &st));
        }
    }
    let (mode, python, ready, _) = resolve(&app);
    let python = python.ok_or("FireVoice's voice engine is not set up on this computer yet. Restart FireVoice to set it up.")?;
    if !ready {
        return Err(if mode == "bundled" {
            "FireVoice's voice engine is not set up yet, or this version of the app needs it updated.".into()
        } else {
            log::warn!("backend python missing: {}", python.display());
            "FireVoice could not find the files it needs to start its voice engine. Restart FireVoice to set it up again.".into()
        });
    }
    let port = port.unwrap_or(8787);
    let log = log_path(&app);
    // keep one older log; a log never grows past about 5 MB
    if fs::metadata(&log).map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = fs::rename(&log, log.with_extension("log.1"));
    }
    let mut f = OpenOptions::new().create(true).append(true).open(&log).map_err(|e| format!("Could not open the log file {}: {e}", log.display()))?;
    let _ = writeln!(f, "\n===== starting FireVoice backend ({mode}) on port {port} =====");
    let err = f.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&python);
    // not `-m firevoice.server`: release builds ship the backend compiled, and Python cannot run a compiled module as a script
    cmd.args(["-X", "utf8", "-c", "import sys; from firevoice.server import main; sys.exit(main())", "--port", &port.to_string()])
        .env("PYTHONUNBUFFERED", "1")
        .env("FIREVOICE_DESKTOP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(f))
        .stderr(Stdio::from(err));
    if mode == "bundled" {
        // the bundled runtime must not pick up a user's PYTHONPATH or PYTHONHOME
        cmd.env_remove("PYTHONPATH").env_remove("PYTHONHOME");
        // engine installs use the torch wheels the app downloaded instead of fetching them again
        cmd.env("FIREVOICE_WHEELS", wheels_dir(&app));
        // and the same Python rules as the runtime: only Pythons uv downloads itself, kept in FireVoice's own folder
        // (an engine on Python 3.11 would otherwise land in uv's shared folder, or on a Python the user installed)
        cmd.env("UV_PYTHON_INSTALL_DIR", runtime_dir(&app).join("python")).env("UV_PYTHON_PREFERENCE", "only-managed");
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn().map_err(|e| {
        log::error!("could not start {}: {e}", python.display());
        format!("FireVoice could not start its voice engine ({e}).")
    })?;
    log::info!("FireVoice backend started, pid {}", child.id());
    *lock(&st.child) = Some(child);
    *lock(&st.port) = Some(port);
    Ok(info(&app, &st))
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

/// Stop the managed server and its engine workers (they are its child processes).
pub fn stop(st: &Backend) {
    let mut guard = lock(&st.child);
    if let Some(mut c) = guard.take() {
        kill_tree(c.id());
        let _ = c.kill();
        let _ = c.wait();
        log::info!("FireVoice backend stopped");
    }
}

/// Stop a setup command still running (the app is quitting): a download resumes where it stopped next time.
pub fn stop_setup(st: &Backend) {
    if let Some(pid) = lock(&st.task_pid).take() {
        kill_tree(pid);
        log::info!("stopped the setup command still running (pid {pid})");
    }
}

#[tauri::command]
pub fn backend_stop(app: AppHandle, st: State<Backend>) -> BackendInfo {
    stop(&st);
    info(&app, &st)
}

#[tauri::command]
pub fn backend_logs(app: AppHandle, lines: Option<usize>) -> String {
    let n = lines.unwrap_or(200);
    let Ok(mut f) = File::open(log_path(&app)) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(256 * 1024)));
    let mut s = String::new();
    let _ = f.read_to_string(&mut s);
    let all: Vec<&str> = s.lines().collect();
    all[all.len().saturating_sub(n)..].join("\n")
}

fn emit(app: &AppHandle, step: u32, steps: u32, message: &str, status: &str, error: Option<String>) {
    let _ = app.emit("backend-setup", SetupEvent { step, steps, message: message.into(), status: status.into(), error });
}

type OnLine = Arc<dyn Fn(&str) + Send + Sync>;

/// Run one command with its output appended to the log; every output line also goes to `on_line`.
fn run_logged(app: &AppHandle, log: &Path, label: &str, cmd: &mut Command, on_line: OnLine) -> Result<(), String> {
    let mut f = OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
    let _ = writeln!(f, "$ {:?}", cmd);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("{label}: {e}"))?;
    let st = app.state::<Backend>();
    *lock(&st.task_pid) = Some(child.id());
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut pumps = vec![];
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let (log, tail, on_line) = (log.to_path_buf(), tail.clone(), on_line.clone());
        pumps.push(thread::spawn(move || {
            let mut f = OpenOptions::new().append(true).open(&log).ok();
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let line = line.trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                // the downloader's progress lines are many and say nothing a person needs in the log
                let progress = line.starts_with("@@ ") && line.contains("\"progress\"");
                if let (Some(f), false) = (f.as_mut(), progress) {
                    let _ = writeln!(f, "{line}");
                }
                on_line(&line);
                if !line.starts_with("@@ ") {
                    let mut t = lock(&tail);
                    t.push(line);
                    let k = t.len().saturating_sub(6);
                    t.drain(..k);
                }
            }
        }));
    }
    let status = child.wait().map_err(|e| e.to_string());
    for p in pumps {
        let _ = p.join();
    }
    *lock(&st.task_pid) = None;
    let status = status?;
    if status.success() {
        Ok(())
    } else {
        let tail = lock(&tail).join(" | ");
        Err(friendly(&tail).unwrap_or_else(|| format!("{label} failed ({status}): {tail}")))
    }
}

/// "C:" for the first `C:\...` or `C:/...` in a text (the drive an error is about), if any.
fn drive_in(s: &str) -> Option<String> {
    let b = s.as_bytes();
    (0..b.len().saturating_sub(2))
        .find(|&i| b[i].is_ascii_alphabetic() && b[i + 1] == b':' && (b[i + 2] == b'\\' || b[i + 2] == b'/') && (i == 0 || !b[i - 1].is_ascii_alphanumeric()))
        .map(|i| format!("{}:", (b[i] as char).to_ascii_uppercase()))
}

/// A plain-language reason for a failed setup command, from the last lines it printed (None when nothing is recognised).
fn friendly(tail: &str) -> Option<String> {
    let t = tail.to_lowercase();
    let has = |keys: &[&str]| keys.iter().any(|k| t.contains(k));
    if has(&["os error 112", "not enough space", "no space left", "enospc", "disk is full"]) {
        let on = drive_in(tail).map(|d| format!(" on drive {d}")).unwrap_or_default();
        return Some(format!("Not enough free disk space{on}. FireVoice needs about 12 GB free to set itself up. Free some space and try again."));
    }
    if has(&["access is denied", "os error 5", "permission denied"]) {
        return Some("Windows would not let FireVoice write its files (an antivirus or a protected folder?). Allow FireVoice in your antivirus and try again.".into());
    }
    if has(&["error sending request", "connection refused", "connection reset", "timed out", "dns error", "failed to lookup", "name resolution", "network is unreachable", "tls handshake"]) {
        return Some("FireVoice could not reach the download servers. Check your internet connection (and any proxy or firewall) and try again.".into());
    }
    None
}

/// The latest line of a step, for the progress screen.
fn step_lines(app: &AppHandle, step: u32, steps: u32, label: &str) -> OnLine {
    let (app, label) = (app.clone(), label.to_string());
    Arc::new(move |line: &str| {
        if line.starts_with("@@ ") {
            return;
        }
        let short: String = line.chars().take(110).collect();
        emit(&app, step, steps, &format!("{label}: {short}"), "running", None);
    })
}

/// uv, set up to build the runtime: it uses only a Python it downloaded itself, into the runtime folder (never one the
/// user installed, which could be removed or upgraded under FireVoice), and it ignores the user's venv.
fn uv_cmd(res: &Path, rt: &Path, args: &[&str]) -> Command {
    let uv = res.join(exe("uv"));
    let uv = if uv.exists() { uv } else { PathBuf::from(exe("uv")) };
    let mut c = Command::new(uv);
    c.args(args)
        .env("UV_PYTHON_INSTALL_DIR", rt.join("python"))
        .env("UV_PYTHON_PREFERENCE", "only-managed")
        .env("UV_LINK_MODE", "hardlink")
        .env_remove("VIRTUAL_ENV")
        .env_remove("PYTHONPATH");
    c
}

/// The pinned constraints file of a two-phase build, if this build has one.
fn constraints(r: &Recipe, res: &Path) -> Option<PathBuf> {
    if r.core_extras.is_empty() {
        return None;
    }
    let p = res.join(r.constraints.as_deref()?);
    if !p.exists() {
        return None;
    }
    if !r.cpu {
        return Some(p);
    }
    let text = cpu_constraints(&fs::read_to_string(&p).ok()?);
    let out = std::env::temp_dir().join("firevoice-constraints-cpu.txt");
    fs::write(&out, text).ok()?;
    Some(out)
}

/// The pinned package list for a computer without an NVIDIA card: the CPU build of torch instead of the CUDA one, and
/// without the CUDA libraries the CUDA build pulls in on Linux (nvidia-*, cuda-*, triton: several GB nothing would use).
fn cpu_constraints(text: &str) -> String {
    text.lines()
        .filter(|l| {
            let n = l.trim_start().to_ascii_lowercase();
            !(n.starts_with("nvidia-") || n.starts_with("cuda-") || n.starts_with("triton=="))
        })
        .map(|l| l.replace("+cu128", "+cpu"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

/// Install every pinned package (torch included), using the downloaded wheels where they are. The overrides the lock
/// was resolved with go along (a dependency's own pin, such as chatterbox-tts on torch 2.6, would refuse the lock).
fn install_all_cmd(app: &AppHandle, r: &Recipe, res: &Path, rt: &Path, py: &Path, lock_file: &Path) -> Result<Command, String> {
    let wheels = wheels_dir(app);
    let _ = fs::create_dir_all(&wheels);
    let overrides = rt.join("overrides.txt");
    fs::write(&overrides, r.overrides.join("\n")).map_err(|e| e.to_string())?;
    Ok(uv_cmd(
        res,
        rt,
        &[
            "pip", "install", "--python", &py.display().to_string(), "-r", &lock_file.display().to_string(), "--override", &overrides.display().to_string(),
            "--find-links", &wheels.display().to_string(), "--extra-index-url", &r.torch_index, "--index-strategy", "unsafe-best-match",
        ],
    ))
}

/// The core setup (the user waits for this): the runtime and enough of FireVoice to start the server.
fn setup_steps(app: &AppHandle, r: &Recipe, res: &Path) -> Result<(), String> {
    let rt = runtime_dir(app);
    fs::create_dir_all(&rt).map_err(|e| e.to_string())?;
    let log = log_path(app);
    let venv = rt.join("venv");
    let py = venv_python(&venv);
    let pyarg = py.display().to_string();
    let wheel = res.join(&r.wheel);
    let lock_file = constraints(r, res);
    // a runtime that already had everything (an app update): bring all of it in step now, before the server starts
    let was_full = installed(app).is_some_and(|i| i.full) && py.exists();
    let _ = fs::remove_file(rt.join("installed.json"));

    let Some(lock_file) = lock_file else {
        // a build from before the two-phase setup: everything, in one go
        return setup_all_at_once(app, r, res, &rt, &log, &py, &wheel);
    };
    let steps = if was_full { 4 } else { 3 };
    emit(app, 0, steps, "Getting the runtime FireVoice needs", "running", None);
    run_logged(app, &log, "Runtime", &mut uv_cmd(res, &rt, &["venv", "--allow-existing", "--python", &r.python, &venv.display().to_string()]), step_lines(app, 0, steps, "Runtime"))?;
    emit(app, 1, steps, "Installing FireVoice", "running", None);
    let spec = format!("{}[{}]", wheel.display(), r.core_extras.join(","));
    run_logged(
        app,
        &log,
        "FireVoice",
        &mut uv_cmd(res, &rt, &["pip", "install", "--python", &pyarg, "--reinstall-package", "firevoice", &spec, "-c", &lock_file.display().to_string()]),
        step_lines(app, 1, steps, "FireVoice"),
    )?;
    let mut k = 2;
    if was_full {
        emit(app, k, steps, "Updating the voice libraries", "running", None);
        run_logged(app, &log, "Voice libraries", &mut install_all_cmd(app, r, res, &rt, &py, &lock_file)?, step_lines(app, k, steps, "Voice libraries"))?;
        k += 1;
    }
    emit(app, k, steps, "Checking that everything works", "running", None);
    let mut check = Command::new(&py);
    let probe = if was_full { "import firevoice, firevoice.server, torch; print('firevoice', firevoice.__version__, 'cuda', torch.cuda.is_available())" } else { "import firevoice, firevoice.server; print('firevoice', firevoice.__version__)" };
    check.args(["-X", "utf8", "-c", probe]);
    run_logged(app, &log, "Check", &mut check, step_lines(app, k, steps, "Check"))?;
    write_installed(app, &Installed { version: r.version.clone(), wheel: r.wheel.clone(), full: was_full })
}

/// The setup of builds without a constraints file: torch, then the backend with all its extras (the user waits).
fn setup_all_at_once(app: &AppHandle, r: &Recipe, res: &Path, rt: &Path, log: &Path, py: &Path, wheel: &Path) -> Result<(), String> {
    let venv = rt.join("venv");
    let torch = [format!("torch=={}", r.torch), format!("torchaudio=={}", r.torch)];
    let steps = 4;
    let pyarg = py.display().to_string();
    emit(app, 0, steps, "Getting the runtime FireVoice needs", "running", None);
    run_logged(app, log, "Runtime", &mut uv_cmd(res, rt, &["venv", "--allow-existing", "--python", &r.python, &venv.display().to_string()]), step_lines(app, 0, steps, "Runtime"))?;
    emit(app, 1, steps, "Installing GPU support (about 3 GB the first time)", "running", None);
    run_logged(app, log, "GPU support", &mut uv_cmd(res, rt, &["pip", "install", "--python", &pyarg, &torch[0], &torch[1], "--index-url", &r.torch_index]), step_lines(app, 1, steps, "GPU support"))?;
    emit(app, 2, steps, "Installing FireVoice's voice engine", "running", None);
    let spec = format!("{}[{}]", wheel.display(), r.extras.join(","));
    let overrides = rt.join("overrides.txt");
    fs::write(&overrides, r.overrides.join("\n")).map_err(|e| e.to_string())?;
    let ovr = overrides.display().to_string();
    run_logged(
        app,
        log,
        "FireVoice",
        &mut uv_cmd(
            res,
            rt,
            &[
                "pip", "install", "--python", &pyarg, "--reinstall-package", "firevoice", &spec, &torch[0], &torch[1], "--override", &ovr, "--extra-index-url", &r.torch_index,
                "--index-strategy", "unsafe-best-match",
            ],
        ),
        step_lines(app, 2, steps, "FireVoice"),
    )?;
    emit(app, 3, steps, "Checking that everything works", "running", None);
    let mut check = Command::new(py);
    check.args(["-X", "utf8", "-c", "import firevoice, firevoice.server, torch; print('firevoice', firevoice.__version__, 'cuda', torch.cuda.is_available())"]);
    run_logged(app, log, "Check", &mut check, step_lines(app, 3, steps, "Check"))?;
    write_installed(app, &Installed { version: r.version.clone(), wheel: r.wheel.clone(), full: true })
}

/// Clears a running flag when its setup ends, however it ends (success, error or a panic in the setup thread), and
/// reports a setup that ended without saying so as failed.
struct SetupGuard {
    app: AppHandle,
    extras: bool,
    reported: bool,
}

impl Drop for SetupGuard {
    fn drop(&mut self) {
        let st = self.app.state::<Backend>();
        if self.extras {
            *lock(&st.extras_running) = false;
            if !self.reported {
                log::error!("background setup stopped unexpectedly");
                extras_update(&self.app, true, |x| {
                    x.status = "failed".into();
                    x.error = Some("Setup stopped unexpectedly. Please try again.".into());
                });
            }
        } else {
            *lock(&st.setup_running) = false;
            if !self.reported {
                log::error!("backend setup stopped unexpectedly");
                emit(&self.app, 0, 4, "Setup failed", "failed", Some("Setup stopped unexpectedly. Please try again.".into()));
            }
        }
    }
}

/// Build (or update) the core of the bundled runtime in the background. Progress arrives as `backend-setup` events.
#[tauri::command]
pub fn backend_setup(app: AppHandle, st: State<Backend>) -> Result<(), String> {
    const NO_BUNDLE: &str = "This copy of FireVoice does not include its voice engine, so it cannot be set up from here. Please reinstall FireVoice.";
    let r = recipe(&app).ok_or(NO_BUNDLE)?;
    let res = resources_dir(&app).ok_or(NO_BUNDLE)?;
    if *lock(&st.extras_running) {
        return Err("FireVoice is still finishing its setup in the background. Try again when it is done.".into());
    }
    {
        let mut running = lock(&st.setup_running);
        if *running {
            return Err("Setup is already running.".into());
        }
        *running = true;
    }
    let mut guard = SetupGuard { app: app.clone(), extras: false, reported: false };
    stop(&st); // an old runtime must not hold files that the update replaces
    let app2 = app.clone();
    let spawned = thread::Builder::new().name("firevoice-setup".into()).spawn(move || {
        let result = setup_steps(&app2, &r, &res);
        guard.reported = true;
        drop(guard); // clears setup_running before the result goes out
        match result {
            Ok(()) => emit(&app2, 4, 4, "FireVoice is ready", "done", None),
            Err(e) => {
                log::error!("backend setup failed: {e}");
                emit(&app2, 0, 4, "Setup failed", "failed", Some(e));
            }
        }
    });
    if let Err(e) = spawned {
        // the closure (and its guard) was dropped without running, which already cleared the flag
        return Err(format!("Could not start setup ({e})."));
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------- the background setup

const W_DOWNLOAD: f64 = 0.8;
const W_INSTALL: f64 = 0.17;

/// Change the background setup's state and tell the UI (at most ~6 times a second, unless `force`).
fn extras_update(app: &AppHandle, force: bool, f: impl FnOnce(&mut Extras)) {
    let st = app.state::<Backend>();
    let mut x = lock(&st.extras);
    f(&mut x);
    // bytes of the downloads the app makes itself, and how fast they come in
    let dl: Vec<&ExtrasItem> = x.items.iter().filter(|i| i.id.starts_with("wheel:")).collect();
    let (done, total) = (dl.iter().map(|i| i.done).sum::<u64>(), dl.iter().map(|i| i.total).sum::<u64>());
    x.done_bytes = done;
    x.total_bytes = total;
    let now = Instant::now();
    match x.speed_at {
        Some((t, b)) if now.duration_since(t).as_secs_f64() >= 1.0 => {
            let rate = done.saturating_sub(b) as f64 / now.duration_since(t).as_secs_f64();
            x.bytes_per_sec = if x.bytes_per_sec > 0.0 { 0.6 * x.bytes_per_sec + 0.4 * rate } else { rate };
            x.speed_at = Some((now, done));
        }
        None => x.speed_at = Some((now, done)),
        _ => {}
    }
    let dl_frac = if total > 0 { done as f64 / total as f64 } else { 0.0 };
    x.progress = match x.stage.as_str() {
        "download" => W_DOWNLOAD * dl_frac,
        "install" => W_DOWNLOAD + W_INSTALL * x.install,
        "check" => W_DOWNLOAD + W_INSTALL,
        _ => x.progress,
    };
    if x.status == "done" {
        x.progress = 1.0;
    }
    if force || x.emitted.is_none_or(|t| now.duration_since(t).as_millis() >= 160) {
        x.emitted = Some(now);
        let _ = app.emit("backend-extras", x.clone());
    }
}

fn item(id: &str, label: &str, total: u64) -> ExtrasItem {
    ExtrasItem { id: id.into(), label: label.into(), done: 0, total, state: "waiting".into() }
}

fn wheel_label(name: &str) -> String {
    match name {
        "torch" => "PyTorch (the speech runtime)".into(),
        "torchaudio" => "Audio support".into(),
        n => n.to_string(),
    }
}

fn set_item(x: &mut Extras, id: &str, f: impl FnOnce(&mut ExtrasItem)) {
    if let Some(i) = x.items.iter_mut().find(|i| i.id == id) {
        f(i);
    }
}

/// "12.0MiB" -> bytes
fn parse_size(s: &str) -> u64 {
    let s = s.trim();
    let (num, mult) = [("GiB", 1u64 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10), ("B", 1)]
        .iter()
        .find_map(|(u, m)| s.strip_suffix(u).map(|n| (n, *m)))
        .unwrap_or((s, 1));
    (num.trim().parse::<f64>().unwrap_or(0.0) * mult as f64) as u64
}

/// The downloader's "@@ {json}" lines.
fn on_download_line(app: &AppHandle, line: &str, problem: &Mutex<Option<String>>) {
    let Some(json) = line.strip_prefix("@@ ") else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return };
    let name = v["name"].as_str().unwrap_or_default().to_string();
    match v["event"].as_str() {
        Some("error") if v["code"].as_str() == Some("disk") => {
            *lock(problem) = Some(format!(
                "Not enough free disk space on {}: FireVoice needs about {:.0} GB free to set itself up and {:.1} GB is free. Free some space and try again.",
                v["drive"].as_str().unwrap_or("the disk"),
                v["need_gb"].as_f64().unwrap_or(12.0),
                v["free_gb"].as_f64().unwrap_or(0.0)
            ));
        }
        Some("plan") => extras_update(app, true, |x| {
            let mut wheels: Vec<ExtrasItem> = v["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|i| {
                    let n = i["name"].as_str().unwrap_or_default();
                    item(&format!("wheel:{n}"), &wheel_label(n), i["total"].as_u64().unwrap_or(0))
                })
                .collect();
            let rest: Vec<ExtrasItem> = x.items.drain(..).filter(|i| !i.id.starts_with("wheel:")).collect();
            wheels.extend(rest);
            x.items = wheels;
        }),
        Some("progress") => extras_update(app, false, |x| {
            let (done, total) = (v["done"].as_u64().unwrap_or(0), v["total"].as_u64().unwrap_or(0));
            set_item(x, &format!("wheel:{name}"), |i| {
                i.done = done;
                if total > 0 {
                    i.total = total;
                }
                i.state = "active".into();
            });
            x.message = format!("Downloading {}", wheel_label(&name));
        }),
        Some("done") => extras_update(app, true, |x| {
            set_item(x, &format!("wheel:{name}"), |i| {
                i.done = i.total;
                i.state = "done".into();
            });
        }),
        _ => {}
    }
}

/// uv's lines while it installs everything else: "Resolved N packages", "Downloading x (12.0MiB)", " Downloaded x",
/// "Prepared N packages", "Installed N packages".
fn on_install_line(app: &AppHandle, line: &str) {
    let l = line.trim();
    extras_update(app, false, |x| {
        if l.starts_with("Resolved ") {
            x.install = x.install.max(0.1);
            x.message = "Working out what is still missing".into();
        } else if let Some(rest) = l.strip_prefix("Downloading ") {
            let (name, size) = rest.split_once(" (").map(|(n, s)| (n, parse_size(s.trim_end_matches(')')))).unwrap_or((rest, 0));
            x.pending.insert(name.to_string(), size);
            set_item(x, "libs", |i| {
                i.total += size;
                i.state = "active".into();
            });
            x.message = format!("Downloading {name}");
        } else if let Some(name) = l.strip_prefix("Downloaded ") {
            x.message = format!("Downloaded {name}");
            // uv prints no byte progress when not on a terminal: a download counts in full once it is finished
            let size = x.pending.remove(name).unwrap_or(0);
            let mut frac = 0.0;
            set_item(x, "libs", |i| {
                i.done = (i.done + size).min(i.total);
                frac = if i.total > 0 { i.done as f64 / i.total as f64 } else { 0.0 };
            });
            x.install = x.install.max(0.1 + 0.7 * frac);
        } else if l.starts_with("Prepared ") {
            x.install = x.install.max(0.85);
            set_item(x, "libs", |i| i.done = i.total);
            x.message = "Putting everything in place".into();
        } else if l.starts_with("Installed ") || l.starts_with("Audited ") {
            x.install = 1.0;
            set_item(x, "libs", |i| {
                i.done = i.total;
                i.state = "done".into();
            });
            x.message = "Installed".into();
        } else if !l.starts_with("@@") && !l.starts_with('+') && !l.starts_with('-') && !l.starts_with("Using ") {
            let short: String = l.chars().take(110).collect();
            x.message = short;
        }
    });
}

fn finish_steps(app: &AppHandle, r: &Recipe, res: &Path, lock_file: &Path) -> Result<(), String> {
    let rt = runtime_dir(app);
    let log = log_path(app);
    let py = venv_python(&rt.join("venv"));
    let wheels = wheels_dir(app);
    fs::create_dir_all(&wheels).map_err(|e| e.to_string())?;

    // 1. torch and torchaudio, with exact progress; if this fails, uv downloads them in step 2 instead
    extras_update(app, true, |x| {
        x.stage = "download".into();
        x.message = "Getting ready to download GPU support".into();
    });
    let script = rt.join("fetch_wheels.py");
    fs::write(&script, FETCH_WHEELS).map_err(|e| e.to_string())?;
    let mut fetch = Command::new(&py);
    fetch
        .args(["-X", "utf8", "-I", &script.display().to_string(), "--index", &r.torch_index, "--dest", &wheels.display().to_string()])
        .arg(format!("torch=={}", r.torch))
        .arg(format!("torchaudio=={}", r.torch))
        .env("PYTHONUNBUFFERED", "1")
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME");
    let a = app.clone();
    let problem: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let p2 = problem.clone();
    if let Err(e) = run_logged(app, &log, "Download", &mut fetch, Arc::new(move |l: &str| on_download_line(&a, l, &p2))) {
        // no room is the one failure uv cannot get around: say so now instead of failing again half way through its install
        if let Some(msg) = lock(&problem).take() {
            return Err(msg);
        }
        log::warn!("the app's own torch download failed, uv downloads it instead: {e}");
        extras_update(app, true, |x| {
            for i in x.items.iter_mut().filter(|i| i.id.starts_with("wheel:") && i.state != "done") {
                i.state = "waiting".into();
            }
        });
    }

    // 2. everything else the runtime needs (only adds packages: every version was pinned at build time)
    extras_update(app, true, |x| {
        x.stage = "install".into();
        x.install = 0.0;
        x.message = "Installing the voice libraries".into();
        set_item(x, "libs", |i| i.state = "active".into());
    });
    let a = app.clone();
    run_logged(app, &log, "Voice libraries", &mut install_all_cmd(app, r, res, &rt, &py, lock_file)?, Arc::new(move |l: &str| on_install_line(&a, l)))?;
    extras_update(app, true, |x| {
        for i in x.items.iter_mut().filter(|i| i.id != "check") {
            i.done = i.total;
            i.state = "done".into();
        }
    });

    // 3. it all loads
    extras_update(app, true, |x| {
        x.stage = "check".into();
        x.message = "Checking that everything works".into();
        set_item(x, "check", |i| i.state = "active".into());
    });
    let mut check = Command::new(&py);
    check.args(["-X", "utf8", "-c", "import firevoice, torch, torchaudio; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"]);
    run_logged(app, &log, "Check", &mut check, Arc::new(|_: &str| {}))?;
    write_installed(app, &Installed { version: r.version.clone(), wheel: r.wheel.clone(), full: true })
}

/// The background half of the setup: torch and the rest, while the server already runs. Progress arrives as
/// `backend-extras` events. Does nothing when everything is already installed.
#[tauri::command]
pub fn backend_finish_setup(app: AppHandle, st: State<Backend>) -> Result<(), String> {
    let (mode, _, ready, full_ready) = resolve(&app);
    if mode != "bundled" || full_ready {
        extras_update(&app, true, |x| {
            x.status = "done".into();
        });
        return Ok(());
    }
    if !ready {
        return Err("FireVoice's voice engine is not set up yet.".into());
    }
    let r = recipe(&app).ok_or("This copy of FireVoice does not include its voice engine.")?;
    let res = resources_dir(&app).ok_or("This copy of FireVoice does not include its voice engine.")?;
    let lock_file = constraints(&r, &res).ok_or("This copy of FireVoice has no list of the packages it needs.")?;
    if *lock(&st.setup_running) {
        return Err("Setup is already running.".into());
    }
    {
        let mut running = lock(&st.extras_running);
        if *running {
            return Ok(()); // already on its way
        }
        *running = true;
    }
    extras_update(&app, true, |x| {
        *x = Extras {
            status: "running".into(),
            stage: "download".into(),
            message: "Starting…".into(),
            items: vec![
                item("wheel:torch", &wheel_label("torch"), 0),
                item("libs", "Voice libraries", 0),
                item("check", "Final check", 0),
            ],
            ..Default::default()
        };
    });
    let mut guard = SetupGuard { app: app.clone(), extras: true, reported: false };
    let app2 = app.clone();
    let spawned = thread::Builder::new().name("firevoice-setup-extras".into()).spawn(move || {
        let result = finish_steps(&app2, &r, &res, &lock_file);
        guard.reported = true;
        drop(guard);
        match result {
            Ok(()) => extras_update(&app2, true, |x| {
                x.status = "done".into();
                x.message = "Everything is installed".into();
                for i in x.items.iter_mut() {
                    i.done = i.total;
                    i.state = "done".into();
                }
            }),
            Err(e) => {
                log::error!("background setup failed: {e}");
                extras_update(&app2, true, |x| {
                    x.status = "failed".into();
                    x.error = Some(e);
                });
            }
        }
    });
    if let Err(e) = spawned {
        return Err(format!("Could not start setup ({e})."));
    }
    Ok(())
}

/// The background setup's latest state (for a window that opens or reloads while it runs).
#[tauri::command]
pub fn backend_extras_status(st: State<Backend>) -> Extras {
    lock(&st.extras).clone()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_cpu_index_sits_next_to_the_cuda_one() {
        assert_eq!(super::cpu_index("https://download.pytorch.org/whl/cu128"), "https://download.pytorch.org/whl/cpu");
        assert_eq!(super::cpu_index("https://download.pytorch.org/whl/cu128/"), "https://download.pytorch.org/whl/cpu");
    }

    #[test]
    fn the_cpu_pins_drop_the_cuda_libraries() {
        let t = super::cpu_constraints("numpy==1.26.4\nnvidia-cublas-cu12==12.8.4.1\ncuda-toolkit==12.8.1\ntorch==2.11.0+cu128\ntriton==3.6.0\ntriton-windows==3.7.1\n");
        assert_eq!(t, "numpy==1.26.4\ntorch==2.11.0+cpu\ntriton-windows==3.7.1\n");
    }

    use super::*;

    #[test]
    fn a_full_disk_is_said_in_plain_words_and_names_the_drive() {
        let m = friendly(r"failed to write to file `C:\Users\naeem\AppData\Local\uv\cache\x.dll`: There is not enough space on the disk. (os error 112)").unwrap();
        assert!(m.starts_with("Not enough free disk space on drive C:"), "{m}");
        assert!(friendly("OSError: [Errno 28] No space left on device").unwrap().starts_with("Not enough free disk space"));
    }

    #[test]
    fn network_and_permission_failures_are_recognised() {
        assert!(friendly("error sending request for url (https://download.pytorch.org/whl/cu128/)").unwrap().contains("internet connection"));
        assert!(friendly("PermissionError: [WinError 5] Access is denied").unwrap().contains("Windows would not let"));
    }

    #[test]
    fn anything_else_is_left_as_it_is() {
        assert!(friendly("something nobody has seen before").is_none());
    }

    #[test]
    fn the_drive_is_found_in_a_path() {
        assert_eq!(drive_in(r"into `d:\x\y`").as_deref(), Some("D:"));
        assert_eq!(drive_in("at E:/data").as_deref(), Some("E:"));
        assert_eq!(drive_in("no path here, only a:b").as_deref(), None);
    }
}
