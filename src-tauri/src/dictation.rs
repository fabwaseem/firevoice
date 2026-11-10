//! Dictation: speak in any program and the words are typed where the cursor is.
//!
//! A global hotkey starts it from anywhere. While it runs:
//!
//! * the microphone is read here (not in the web view, which is slowed down or stopped while its window is hidden),
//!   mixed to mono, brought down to 16 kHz and sent to the backend's live route (`/api/v1/dictate`) as it arrives;
//! * the backend answers with text as soon as it is certain of it. In real-time mode each piece is typed into the
//!   focused program at once; in on-stop mode the whole text is inserted when the speaker stops;
//! * a small window that never takes the keyboard focus (label `dictation`, page `overlay.html`) shows the level of
//!   the voice and the words as they form.
//!
//! The web side owns the settings and sends them here (`dictation_configure`) at start and on every change. What
//! happens is reported as events: `dictation` (state), `dictation-level`, `dictation-text` and `dictation-result`.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

/// The rate the speech model hears. A faster microphone is brought down to it here; a slower one is sent as it is.
const RATE: u32 = 16_000;
/// A hold shorter than this was a slip of the finger, not a dictation.
const MIN_HOLD: Duration = Duration::from_millis(250);
/// Nobody dictates this long without a break: a forgotten session ends by itself.
const MAX_SESSION: Duration = Duration::from_secs(15 * 60);

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    pub enabled: bool,
    /// e.g. "Ctrl+Alt+Space"
    pub hotkey: String,
    /// "toggle" (press to start, press to stop) or "hold" (speak while the keys are down)
    pub activation: String,
    /// "realtime" (typed as you speak) or "onstop" (inserted when you stop)
    pub mode: String,
    /// "auto" or a language code
    pub language: String,
    /// "type" (keystrokes) or "paste" (through the clipboard, which is put back afterwards)
    pub insert: String,
    pub commands: bool,
    pub fillers: bool,
    pub keyterms: Vec<String>,
    /// the microphone's name; empty = the system's default
    pub mic: String,
    /// keep FireVoice running in the tray when its window is closed, so the hotkey keeps working
    pub keep_in_tray: bool,
    pub server: String,
    pub token: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            enabled: false,
            hotkey: "Ctrl+Alt+Space".into(),
            activation: "toggle".into(),
            mode: "realtime".into(),
            language: "auto".into(),
            insert: "type".into(),
            commands: true,
            fillers: true,
            keyterms: vec![],
            mic: String::new(),
            keep_in_tray: true,
            server: "http://127.0.0.1:8787".into(),
            token: String::new(),
        }
    }
}

/// One running dictation.
struct Session {
    /// ends it: the rest of the speech is transcribed and inserted
    stop: Arc<AtomicBool>,
    /// ends it and throws the text away
    cancel: Arc<AtomicBool>,
    started: Instant,
}

#[derive(Default)]
pub struct Dictation {
    config: Mutex<Config>,
    session: Mutex<Option<Session>>,
    /// the hotkey that is registered now, if any
    hotkey: Mutex<Option<String>>,
    last_toggle: Mutex<Option<Instant>>,
}

#[derive(Serialize, Clone, Debug)]
struct StateEvent {
    /// idle | starting | listening | finishing | error
    state: &'static str,
    message: Option<String>,
    mode: String,
}

#[derive(Serialize, Clone, Debug)]
struct TextEvent {
    /// everything that is final so far
    text: String,
    /// the still-changing guess after it
    tentative: String,
}

#[derive(Serialize, Clone, Debug)]
struct ResultEvent {
    text: String,
    seconds: f64,
    language: Option<String>,
    mode: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Status {
    enabled: bool,
    hotkey: String,
    /// why the hotkey could not be registered (another program has it, or it is not a valid combination)
    hotkey_error: Option<String>,
    active: bool,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn emit_state(app: &AppHandle, state: &'static str, message: Option<String>) {
    let mode = lock(&app.state::<Dictation>().config).mode.clone();
    let _ = app.emit("dictation", StateEvent { state, message, mode });
}

// ---------------------------------------------------------------------------------------------- overlay window

/// Show the overlay at the bottom centre of the screen the mouse is on, without taking the keyboard focus.
fn show_overlay(app: &AppHandle) {
    let Some(w) = app.get_webview_window("dictation") else { return };
    let _ = w.set_ignore_cursor_events(true);
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    if let (Some(m), Ok(size)) = (monitor, w.outer_size()) {
        let area = m.work_area();
        let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
        let y = area.position.y + area.size.height as i32 - size.height as i32 - (28.0 * m.scale_factor()) as i32;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    let _ = w.show();
}

/// Hide the overlay a moment after a dictation ends, unless another one has started by then.
fn hide_overlay_later(app: &AppHandle, after: Duration) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(after).await;
        if lock(&app.state::<Dictation>().session).is_none() {
            if let Some(w) = app.get_webview_window("dictation") {
                let _ = w.hide();
            }
        }
    });
}

// ---------------------------------------------------------------------------------------------- microphone

/// Mixes to mono and brings the rate down to RATE by averaging, which also keeps high sounds from folding into the
/// speech band. A microphone at RATE or below passes through at its own rate.
struct Downmix {
    channels: usize,
    step: f64, // output samples per input frame
    pos: f64,
    sum: f32,
    n: u32,
}

impl Downmix {
    fn new(channels: usize, rate: u32) -> (Self, u32) {
        let out = rate.min(RATE);
        (Downmix { channels: channels.max(1), step: out as f64 / rate as f64, pos: 0.0, sum: 0.0, n: 0 }, out)
    }

    fn push(&mut self, frames: impl Iterator<Item = f32>, out: &mut Vec<i16>) -> f32 {
        let (mut frame, mut k, mut energy, mut count) = (0.0f32, 0usize, 0.0f32, 0u32);
        for s in frames {
            frame += s;
            k += 1;
            if k < self.channels {
                continue;
            }
            let mono = frame / self.channels as f32;
            (frame, k) = (0.0, 0);
            energy += mono * mono;
            count += 1;
            self.sum += mono;
            self.n += 1;
            self.pos += self.step;
            if self.pos >= 1.0 {
                self.pos -= 1.0;
                let v = (self.sum / self.n as f32).clamp(-1.0, 1.0);
                out.push((v * 32767.0) as i16);
                (self.sum, self.n) = (0.0, 0);
            }
        }
        if count == 0 { 0.0 } else { (energy / count as f32).sqrt() }
    }
}

fn input_device(name: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if !name.is_empty() {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(d) = devices.find(|d| d.description().map(|x| x.name() == name).unwrap_or(false)) {
                return Ok(d);
            }
        }
        log::warn!("dictation: microphone {name:?} is not there, using the default one");
    }
    host.default_input_device().ok_or_else(|| "No microphone was found. Plug one in, or check Windows sound settings.".to_string())
}

/// Read the microphone until `stop`: 16-bit mono pieces go to `audio`, the loudness of the latest piece to `level`.
/// -> the rate of what is sent. The stream lives on its own thread (it cannot move between threads).
fn start_mic(name: String, stop: Arc<AtomicBool>, audio: UnboundedSender<Vec<u8>>, level: Arc<AtomicU32>) -> Result<u32, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    thread::Builder::new()
        .name("firevoice-mic".into())
        .spawn(move || {
            let open = || -> Result<(cpal::Stream, u32), String> {
                let device = input_device(&name)?;
                let cfg = device.default_input_config().map_err(|e| format!("The microphone could not be opened ({e})."))?;
                let (mut mix, rate) = Downmix::new(cfg.channels() as usize, cfg.sample_rate());
                let fail = |e| log::error!("dictation: microphone error: {e}");
                let mut send = move |frames: &mut dyn Iterator<Item = f32>| {
                    let mut out = Vec::with_capacity(512);
                    let rms = mix.push(frames, &mut out);
                    level.store(rms.to_bits(), Ordering::Relaxed);
                    if !out.is_empty() {
                        let _ = audio.send(out.iter().flat_map(|s| s.to_le_bytes()).collect());
                    }
                };
                let config = cfg.config();
                let stream = match cfg.sample_format() {
                    cpal::SampleFormat::F32 => device.build_input_stream(config, move |d: &[f32], _: &_| send(&mut d.iter().copied()), fail, None),
                    cpal::SampleFormat::I16 => {
                        device.build_input_stream(config, move |d: &[i16], _: &_| send(&mut d.iter().map(|s| *s as f32 / 32768.0)), fail, None)
                    }
                    cpal::SampleFormat::U16 => {
                        device.build_input_stream(config, move |d: &[u16], _: &_| send(&mut d.iter().map(|s| (*s as f32 - 32768.0) / 32768.0)), fail, None)
                    }
                    cpal::SampleFormat::I32 => {
                        device.build_input_stream(config, move |d: &[i32], _: &_| send(&mut d.iter().map(|s| *s as f32 / 2147483648.0)), fail, None)
                    }
                    other => return Err(format!("The microphone's sound format ({other:?}) is not supported.")),
                }
                .map_err(|e| format!("The microphone could not be opened ({e})."))?;
                stream.play().map_err(|e| format!("The microphone could not be started ({e})."))?;
                Ok((stream, rate))
            };
            match open() {
                Ok((stream, rate)) => {
                    let _ = ready_tx.send(Ok(rate));
                    while !stop.load(Ordering::Relaxed) {
                        thread::sleep(Duration::from_millis(15));
                    }
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "The microphone did not answer.".to_string())?
}

#[tauri::command]
pub fn dictation_mics() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices().map(|ds| ds.filter_map(|d| d.description().ok().map(|x| x.name().to_string())).collect()).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------- typing

/// Are Ctrl, Alt, Shift or the Windows key down right now? Text typed while they are would be read as shortcuts.
fn modifiers_down() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
        [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN].iter().any(|k| unsafe { GetAsyncKeyState(*k as i32) } as u16 & 0x8000 != 0)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Puts text into the focused program, in order, on a thread of its own (so a slow program never holds up the audio).
struct Typist {
    tx: mpsc::Sender<String>,
}

impl Typist {
    fn start(paste: bool) -> Typist {
        let (tx, rx) = mpsc::channel::<String>();
        thread::Builder::new()
            .name("firevoice-type".into())
            .spawn(move || {
                let mut enigo = match Enigo::new(&Settings::default()) {
                    Ok(e) => e,
                    Err(e) => {
                        log::error!("dictation: cannot type into other programs: {e}");
                        return;
                    }
                };
                for text in rx {
                    // wait for the hotkey's own keys to come up (hold-to-talk, or a slow finger on a toggle)
                    let t0 = Instant::now();
                    while modifiers_down() && t0.elapsed() < Duration::from_secs(20) {
                        thread::sleep(Duration::from_millis(15));
                    }
                    let r = if paste { paste_text(&mut enigo, &text) } else { type_text(&mut enigo, &text) };
                    if let Err(e) = r {
                        log::error!("dictation: could not insert text: {e}");
                    }
                }
            })
            .ok();
        Typist { tx }
    }

    fn insert(&self, text: &str) {
        if !text.is_empty() {
            let _ = self.tx.send(text.to_string());
        }
    }
}

/// A line break goes in as Shift+Enter: a new line in editors and, unlike Enter, also in chat boxes (where Enter sends).
fn line_break(enigo: &mut Enigo) -> Result<(), String> {
    enigo.key(Key::Shift, Direction::Press).map_err(|e| e.to_string())?;
    let r = enigo.key(Key::Return, Direction::Click).map_err(|e| e.to_string());
    enigo.key(Key::Shift, Direction::Release).map_err(|e| e.to_string())?;
    r
}

fn type_text(enigo: &mut Enigo, text: &str) -> Result<(), String> {
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            line_break(enigo)?;
        }
        if !line.is_empty() {
            enigo.text(line).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn paste_text(enigo: &mut Enigo, text: &str) -> Result<(), String> {
    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let before = clip.get_text().ok();
    clip.set_text(text.to_string()).map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_millis(30));
    enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
    let r = enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string());
    enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
    r?;
    // give the program time to read the clipboard, then put back what was there
    thread::sleep(Duration::from_millis(250));
    if let Some(b) = before {
        let _ = clip.set_text(b);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------- one dictation

fn ws_url(server: &str, token: &str) -> String {
    let base = server.trim_end_matches('/');
    let base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        format!("ws://{}", base.strip_prefix("http://").unwrap_or(base))
    };
    if token.is_empty() { format!("{base}/api/v1/dictate") } else { format!("{base}/api/v1/dictate?token={token}") }
}

#[derive(Deserialize, Debug)]
struct ServerMsg {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    commit: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    tentative: String,
    #[serde(default)]
    replace: bool,
    #[serde(default)]
    seconds: f64,
    language: Option<String>,
    message: Option<String>,
}

/// Connect, stream the microphone, insert the text. -> what was dictated, or a message for the user.
async fn run(app: &AppHandle, cfg: &Config, stop: Arc<AtomicBool>, cancel: Arc<AtomicBool>) -> Result<Option<ResultEvent>, String> {
    let engine_down = "FireVoice's voice engine is not running. Open FireVoice and wait until it is ready.";
    let level = Arc::new(AtomicU32::new(0));
    let mic_stop = Arc::new(AtomicBool::new(false));
    let (audio_tx, mut audio_rx): (UnboundedSender<Vec<u8>>, UnboundedReceiver<Vec<u8>>) = unbounded_channel();
    // the microphone opens first, so nothing said while the connection is made is lost
    let (name, stop2) = (cfg.mic.clone(), mic_stop.clone());
    let level2 = level.clone();
    let rate = tokio::task::spawn_blocking(move || start_mic(name, stop2, audio_tx, level2)).await.map_err(|e| e.to_string())??;
    struct StopMic(Arc<AtomicBool>);
    impl Drop for StopMic {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }
    let _mic = StopMic(mic_stop.clone());

    let (ws, _) = tokio::time::timeout(Duration::from_secs(4), tokio_tungstenite::connect_async(ws_url(&cfg.server, &cfg.token)))
        .await
        .map_err(|_| engine_down.to_string())?
        .map_err(|e| {
            log::warn!("dictation: cannot reach the backend: {e}");
            engine_down.to_string()
        })?;
    let (mut tx, mut rx) = ws.split();
    let realtime = cfg.mode != "onstop";
    let start = serde_json::json!({
        "type": "start", "language": cfg.language, "keyterms": cfg.keyterms, "commands": cfg.commands, "fillers": cfg.fillers,
        "refine": !realtime, "sample_rate": rate,
    });
    tx.send(Message::Text(start.to_string().into())).await.map_err(|e| e.to_string())?;

    let typist = Typist::start(cfg.insert == "paste");
    emit_state(app, "listening", None);
    let mut ticker = tokio::time::interval(Duration::from_millis(33));
    let t0 = Instant::now();
    let mut stopping: Option<Instant> = None;
    let mut typed = String::new();
    loop {
        tokio::select! {
            chunk = audio_rx.recv(), if stopping.is_none() => {
                if let Some(c) = chunk {
                    tx.send(Message::Binary(c.into())).await.map_err(|_| engine_down.to_string())?;
                }
            }
            msg = rx.next() => {
                let Some(Ok(msg)) = msg else { return Err("The connection to FireVoice's voice engine was lost.".into()) };
                let Message::Text(t) = msg else { continue };
                let Ok(m) = serde_json::from_str::<ServerMsg>(&t) else { continue };
                match m.kind.as_str() {
                    "partial" => {
                        if realtime {
                            typist.insert(&m.commit);
                            typed.push_str(&m.commit);
                        }
                        let _ = app.emit("dictation-text", TextEvent { text: m.text, tentative: m.tentative });
                    }
                    "final" => {
                        let text = if realtime {
                            typist.insert(&m.commit);
                            typed.push_str(&m.commit);
                            typed
                        } else {
                            let _ = m.replace;
                            typist.insert(&m.text);
                            m.text
                        };
                        if text.trim().is_empty() {
                            return Ok(None);
                        }
                        // a space after it, so the next dictation (or typing) does not run into this one
                        if !text.ends_with('\n') {
                            typist.insert(" ");
                        }
                        let _ = app.emit("dictation-text", TextEvent { text: text.clone(), tentative: String::new() });
                        return Ok(Some(ResultEvent { text, seconds: m.seconds, language: m.language, mode: cfg.mode.clone() }));
                    }
                    "error" => return Err(m.message.unwrap_or_else(|| "FireVoice's voice engine reported a problem.".into())),
                    _ => {}
                }
            }
            _ = ticker.tick() => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = tx.send(Message::Text(r#"{"type":"cancel"}"#.into())).await;
                    return Ok(None);
                }
                match stopping {
                    None => {
                        let _ = app.emit("dictation-level", f32::from_bits(level.load(Ordering::Relaxed)));
                        if stop.load(Ordering::Relaxed) || t0.elapsed() > MAX_SESSION {
                            // let the last sound through, then say that the speaker is done
                            mic_stop.store(true, Ordering::Relaxed);
                            tokio::time::sleep(Duration::from_millis(60)).await;
                            while let Ok(c) = audio_rx.try_recv() {
                                tx.send(Message::Binary(c.into())).await.map_err(|_| engine_down.to_string())?;
                            }
                            tx.send(Message::Text(r#"{"type":"stop"}"#.into())).await.map_err(|_| engine_down.to_string())?;
                            stopping = Some(Instant::now());
                            emit_state(app, "finishing", None);
                        }
                    }
                    Some(since) if since.elapsed() > Duration::from_secs(20) => {
                        return Err("FireVoice's voice engine took too long to finish the text.".into());
                    }
                    Some(_) => {}
                }
            }
        }
    }
}

fn start(app: &AppHandle) {
    let st = app.state::<Dictation>();
    let cfg = lock(&st.config).clone();
    let (stop, cancel) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    {
        let mut s = lock(&st.session);
        if s.is_some() {
            return;
        }
        *s = Some(Session { stop: stop.clone(), cancel: cancel.clone(), started: Instant::now() });
    }
    show_overlay(app);
    emit_state(app, "starting", None);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run(&app, &cfg, stop, cancel).await;
        *lock(&app.state::<Dictation>().session) = None;
        match result {
            Ok(Some(r)) => {
                let _ = app.emit("dictation-result", r);
                emit_state(&app, "idle", None);
                hide_overlay_later(&app, Duration::from_millis(900));
            }
            Ok(None) => {
                emit_state(&app, "idle", None);
                hide_overlay_later(&app, Duration::from_millis(250));
            }
            Err(e) => {
                log::warn!("dictation ended with an error: {e}");
                emit_state(&app, "error", Some(e));
                hide_overlay_later(&app, Duration::from_millis(3200));
            }
        }
    });
}

fn stop(app: &AppHandle, cancel: bool) {
    if let Some(s) = lock(&app.state::<Dictation>().session).as_ref() {
        if cancel {
            s.cancel.store(true, Ordering::Relaxed);
        } else {
            s.stop.store(true, Ordering::Relaxed);
        }
    }
}

fn active(app: &AppHandle) -> bool {
    lock(&app.state::<Dictation>().session).is_some()
}

/// Start a dictation, or end the one that is running (the tray menu and the app's own button).
pub fn toggle(app: &AppHandle) {
    if active(app) { stop(app, false) } else { start(app) }
}

fn on_hotkey(app: &AppHandle, state: ShortcutState) {
    let st = app.state::<Dictation>();
    let hold = lock(&st.config).activation == "hold";
    match (hold, state) {
        (true, ShortcutState::Pressed) => start(app),
        (true, ShortcutState::Released) => {
            let short = lock(&st.session).as_ref().map(|s| s.started.elapsed() < MIN_HOLD).unwrap_or(false);
            stop(app, short);
        }
        (false, ShortcutState::Pressed) => {
            // a key held down repeats: one press is one toggle
            let mut last = lock(&st.last_toggle);
            if last.map(|t| t.elapsed() < Duration::from_millis(350)).unwrap_or(false) {
                return;
            }
            *last = Some(Instant::now());
            drop(last);
            toggle(app);
        }
        (false, ShortcutState::Released) => {}
    }
}

fn status(app: &AppHandle, hotkey_error: Option<String>) -> Status {
    let st = app.state::<Dictation>();
    let cfg = lock(&st.config);
    Status { enabled: cfg.enabled, hotkey: cfg.hotkey.clone(), hotkey_error, active: lock(&st.session).is_some() }
}

/// Take the settings from the web side and (re)register the hotkey.
#[tauri::command]
pub fn dictation_configure(app: AppHandle, st: State<Dictation>, config: Config) -> Status {
    let shortcuts = app.global_shortcut();
    if let Some(old) = lock(&st.hotkey).take() {
        let _ = shortcuts.unregister(old.as_str());
    }
    let mut error = None;
    if config.enabled && !config.hotkey.trim().is_empty() {
        match shortcuts.on_shortcut(config.hotkey.as_str(), |app, _shortcut, event| on_hotkey(app, event.state)) {
            Ok(()) => *lock(&st.hotkey) = Some(config.hotkey.clone()),
            Err(e) => {
                log::warn!("dictation: cannot register {}: {e}", config.hotkey);
                error = Some("This key combination is taken by another program, or cannot be used. Choose another one.".to_string());
            }
        }
    }
    if !config.enabled {
        stop(&app, true);
    }
    *lock(&st.config) = config;
    status(&app, error)
}

#[tauri::command]
pub fn dictation_toggle(app: AppHandle) {
    toggle(&app);
}

#[tauri::command]
pub fn dictation_cancel(app: AppHandle) {
    stop(&app, true);
}

/// Does closing the main window only hide it (the hotkey keeps working from the tray)?
pub fn stays_in_tray(app: &AppHandle) -> bool {
    let st = app.state::<Dictation>();
    let cfg = lock(&st.config);
    cfg.enabled && cfg.keep_in_tray
}
