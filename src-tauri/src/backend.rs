//! The FireVoice backend as a managed sidecar.
//!
//! The backend is a standalone Python service (`firevoice serve`); the app never depends on it being started by the
//! app, and the app works against any running FireVoice server. When the user lets the app manage it, this module:
//!
//! * finds the Python that runs it, in this order: `FIREVOICE_BACKEND_PYTHON`; the bundled runtime (built on first
//!   run from the wheel, uv and recipe that the desktop build copies into `resources/backend/`); in debug builds, the
//!   repo's `backend/.venv` (linked by `scripts/dev-setup.mjs`, running the code in `backend/`);
//! * builds the bundled runtime with uv (a private Python 3.12 venv in the app's local data folder, CUDA torch, then
//!   the backend wheel with its `desktop` extra), reporting progress as `backend-setup` events;
//! * starts `python -m firevoice.cli serve` with its output in the app log folder, and stops it (with its engine
//!   worker processes) on request and when the app exits.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct Backend {
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    setup_running: Mutex<bool>,
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
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Installed {
    version: String,
    wheel: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct BackendInfo {
    /// "custom" (FIREVOICE_BACKEND_PYTHON), "bundled", "dev" (sibling checkout) or "none"
    mode: String,
    python: Option<String>,
    /// The Python exists and, for the bundled runtime, matches the bundled version.
    ready: bool,
    bundled_version: Option<String>,
    bundled_api_version: Option<u32>,
    installed_version: Option<String>,
    running: bool,
    pid: Option<u32>,
    port: Option<u16>,
    log_path: String,
    runtime_dir: String,
    setup_running: bool,
}

#[derive(Serialize, Clone, Debug)]
struct SetupEvent {
    step: u32,
    steps: u32,
    message: String,
    status: String, // running | done | failed
    error: Option<String>,
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
    serde_json::from_str(&fs::read_to_string(d.join("backend.json")).ok()?).ok()
}

fn runtime_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("FireVoice")).join("backend")
}

fn installed(app: &AppHandle) -> Option<Installed> {
    serde_json::from_str(&fs::read_to_string(runtime_dir(app).join("installed.json")).ok()?).ok()
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

/// (mode, python, ready)
fn resolve(app: &AppHandle) -> (String, Option<PathBuf>, bool) {
    if let Ok(p) = std::env::var("FIREVOICE_BACKEND_PYTHON") {
        let p = PathBuf::from(p);
        let ok = p.exists();
        return ("custom".into(), Some(p), ok);
    }
    // `tauri dev` copies the staged resources too: in a debug build the source checkout wins, unless
    // FIREVOICE_DESKTOP_BUNDLED=1 asks to exercise the bundled runtime.
    let prefer_bundled = std::env::var("FIREVOICE_DESKTOP_BUNDLED").is_ok_and(|v| v == "1");
    if !prefer_bundled {
        if let Some(p) = dev_python() {
            return ("dev".into(), Some(p), true);
        }
    }
    if let Some(r) = recipe(app) {
        let py = venv_python(&runtime_dir(app).join("venv"));
        let ok = py.exists() && installed(app).map(|i| i.version == r.version && i.wheel == r.wheel).unwrap_or(false);
        return ("bundled".into(), Some(py), ok);
    }
    ("none".into(), None, false)
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
    let (mode, python, ready) = resolve(app);
    let mut child = lock(&st.child);
    let running = alive(&mut child);
    let r = recipe(app);
    BackendInfo {
        mode,
        python: python.map(|p| p.display().to_string()),
        ready,
        bundled_version: r.as_ref().map(|r| r.version.clone()),
        bundled_api_version: r.as_ref().map(|r| r.api_version),
        installed_version: installed(app).map(|i| i.version),
        running,
        pid: child.as_ref().map(|c| c.id()),
        port: if running { *lock(&st.port) } else { None },
        log_path: log_path(app).display().to_string(),
        runtime_dir: runtime_dir(app).display().to_string(),
        setup_running: *lock(&st.setup_running),
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
    let (mode, python, ready) = resolve(&app);
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
    let mut f = OpenOptions::new().create(true).append(true).open(&log).map_err(|e| format!("Could not open the log file {}: {e}", log.display()))?;
    let _ = writeln!(f, "\n===== starting FireVoice backend ({mode}) on port {port} =====");
    let err = f.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&python);
    cmd.args(["-X", "utf8", "-m", "firevoice.cli", "serve", "--port", &port.to_string()])
        .env("PYTHONUNBUFFERED", "1")
        .env("FIREVOICE_DESKTOP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(f))
        .stderr(Stdio::from(err));
    if mode == "bundled" {
        // the bundled runtime must not pick up a user's PYTHONPATH or PYTHONHOME
        cmd.env_remove("PYTHONPATH").env_remove("PYTHONHOME");
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

/// Stop the managed server and its engine workers (they are its child processes).
pub fn stop(st: &Backend) {
    let mut guard = lock(&st.child);
    if let Some(mut c) = guard.take() {
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &c.id().to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = c.kill();
        let _ = c.wait();
        log::info!("FireVoice backend stopped");
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

/// Run one command, its output appended to the log; the latest line goes out as the step's message.
fn run_logged(app: &AppHandle, log: &Path, step: u32, steps: u32, label: &str, cmd: &mut Command) -> Result<(), String> {
    let mut f = OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
    let _ = writeln!(f, "$ {:?}", cmd);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("{label}: {e}"))?;
    let tail = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let mut pumps = vec![];
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let (app, log, tail, label) = (app.clone(), log.to_path_buf(), tail.clone(), label.to_string());
        pumps.push(thread::spawn(move || {
            let mut f = OpenOptions::new().append(true).open(&log).ok();
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let line = line.trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                if let Some(f) = f.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
                let short: String = line.chars().take(110).collect();
                emit(&app, step, steps, &format!("{label}: {short}"), "running", None);
                let mut t = lock(&tail);
                t.push(line);
                let k = t.len().saturating_sub(6);
                t.drain(..k);
            }
        }));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    for p in pumps {
        let _ = p.join();
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("{label} failed ({status}): {}", lock(&tail).join(" | ")))
    }
}

fn setup_steps(app: &AppHandle, r: &Recipe, res: &Path) -> Result<(), String> {
    let rt = runtime_dir(app);
    fs::create_dir_all(&rt).map_err(|e| e.to_string())?;
    let log = log_path(app);
    let uv = res.join(exe("uv"));
    let uv = if uv.exists() { uv } else { PathBuf::from(exe("uv")) };
    let venv = rt.join("venv");
    let py = venv_python(&venv);
    let wheel = res.join(&r.wheel);
    let torch = [format!("torch=={}", r.torch), format!("torchaudio=={}", r.torch)];
    let steps = 4;
    let uv_cmd = |args: &[&str]| {
        let mut c = Command::new(&uv);
        c.args(args)
            .env("UV_PYTHON_INSTALL_DIR", rt.join("python"))
            .env("UV_LINK_MODE", "hardlink")
            .env_remove("VIRTUAL_ENV")
            .env_remove("PYTHONPATH");
        c
    };
    let _ = fs::remove_file(rt.join("installed.json"));
    emit(app, 0, steps, "Getting the runtime FireVoice needs", "running", None);
    run_logged(app, &log, 0, steps, "Runtime", &mut uv_cmd(&["venv", "--allow-existing", "--python", &r.python, &venv.display().to_string()]))?;
    emit(app, 1, steps, "Installing GPU support (about 3 GB the first time)", "running", None);
    let pyarg = py.display().to_string();
    run_logged(app, &log, 1, steps, "GPU support", &mut uv_cmd(&["pip", "install", "--python", &pyarg, &torch[0], &torch[1], "--index-url", &r.torch_index]))?;
    emit(app, 2, steps, "Installing FireVoice's voice engine", "running", None);
    let spec = format!("{}[{}]", wheel.display(), r.extras.join(","));
    let overrides = rt.join("overrides.txt");
    fs::write(&overrides, r.overrides.join("\n")).map_err(|e| e.to_string())?;
    let ovr = overrides.display().to_string();
    run_logged(
        app,
        &log,
        2,
        steps,
        "FireVoice",
        &mut uv_cmd(&[
            "pip", "install", "--python", &pyarg, "--reinstall-package", "firevoice", &spec, &torch[0], &torch[1], "--override", &ovr, "--extra-index-url", &r.torch_index,
            "--index-strategy", "unsafe-best-match",
        ]),
    )?;
    emit(app, 3, steps, "Checking that everything works", "running", None);
    let mut check = Command::new(&py);
    check.args(["-X", "utf8", "-c", "import firevoice, firevoice.server, torch; print('firevoice', firevoice.__version__, 'cuda', torch.cuda.is_available())"]);
    run_logged(app, &log, 3, steps, "Check", &mut check)?;
    let done = Installed { version: r.version.clone(), wheel: r.wheel.clone() };
    let done = serde_json::to_string_pretty(&done).map_err(|e| e.to_string())?;
    fs::write(rt.join("installed.json"), done).map_err(|e| e.to_string())?;
    Ok(())
}

/// Clears `setup_running` when setup ends, however it ends (success, error or a panic in the setup thread), and
/// reports a setup that ended without saying so as failed.
struct SetupGuard {
    app: AppHandle,
    reported: bool,
}

impl Drop for SetupGuard {
    fn drop(&mut self) {
        *lock(&self.app.state::<Backend>().setup_running) = false;
        if !self.reported {
            log::error!("backend setup stopped unexpectedly");
            emit(&self.app, 0, 4, "Setup failed", "failed", Some("Setup stopped unexpectedly. Please try again.".into()));
        }
    }
}

/// Build (or update) the bundled backend runtime in the background. Progress arrives as `backend-setup` events.
#[tauri::command]
pub fn backend_setup(app: AppHandle, st: State<Backend>) -> Result<(), String> {
    const NO_BUNDLE: &str = "This copy of FireVoice does not include its voice engine, so it cannot be set up from here. Please reinstall FireVoice.";
    let r = recipe(&app).ok_or(NO_BUNDLE)?;
    let res = resources_dir(&app).ok_or(NO_BUNDLE)?;
    {
        let mut running = lock(&st.setup_running);
        if *running {
            return Err("Setup is already running.".into());
        }
        *running = true;
    }
    let mut guard = SetupGuard { app: app.clone(), reported: false };
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
