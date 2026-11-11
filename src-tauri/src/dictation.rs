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
    /// whisper mode: quiet speech is brought up to a normal level before the speech model hears it
    pub boost_quiet: bool,
    /// keep each dictation in the history (Dictation page)
    pub history: bool,
    /// command mode: select text, press this, say what to do with it ("" = off)
    pub command_hotkey: String,
    /// more start options for the server, passed on as they are (the writing assistant: "polish", "styles")
    pub extra: serde_json::Value,
    pub server: String,
    pub token: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            enabled: false,
            hotkey: "Ctrl+Alt+Space".into(),
            activation: "toggle".into(),
            mode: "onstop".into(),
            language: "auto".into(),
            insert: "type".into(),
            commands: true,
            fillers: true,
            keyterms: vec![],
            mic: String::new(),
            keep_in_tray: true,
            boost_quiet: false,
            history: true,
            command_hotkey: String::new(),
            extra: serde_json::Value::Null,
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
    /// hands-free: started by a double tap in hold-to-talk, so letting go of the keys does not end it (a tap does)
    locked: bool,
    /// command mode: what is said is an instruction for the writing assistant, on the selected text
    command: bool,
}

#[derive(Default)]
pub struct Dictation {
    config: Mutex<Config>,
    session: Mutex<Option<Session>>,
    /// the hotkeys that are registered now
    hotkeys: Mutex<Vec<String>>,
    last_toggle: Mutex<Option<Instant>>,
    /// hold-to-talk: when a quick tap (too short to be a dictation) last ended, for spotting a double tap
    last_tap: Mutex<Option<Instant>>,
    /// hold-to-talk: the release that follows the tap that ended a hands-free dictation is not a new one
    swallow_release: Mutex<bool>,
}

/// A second tap this soon after a quick one is a double tap: hands-free dictation.
const DOUBLE_TAP: Duration = Duration::from_millis(450);

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
    let st = app.state::<Dictation>();
    let command = lock(&st.session).as_ref().is_some_and(|s| s.command);
    let mode = if command { "command".to_string() } else { lock(&st.config).mode.clone() };
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
    /// whisper mode: how much quiet speech is brought up (1 = as it is); follows the voice slowly, never the noise
    boost: bool,
    gain: f32,
}

/// Whisper mode: speech is brought up towards this loudness (RMS), by at most MAX_GAIN, and only sound above
/// NOISE_FLOOR counts as speech (so room noise in the pauses is not turned up).
const TARGET_RMS: f32 = 0.08;
const MAX_GAIN: f32 = 6.0;
const NOISE_FLOOR: f32 = 0.004;

impl Downmix {
    fn new(channels: usize, rate: u32, boost: bool) -> (Self, u32) {
        let out = rate.min(RATE);
        (Downmix { channels: channels.max(1), step: out as f64 / rate as f64, pos: 0.0, sum: 0.0, n: 0, boost, gain: 1.0 }, out)
    }

    /// The gain for the next piece, from the loudness of this one (whisper mode only).
    fn follow(&mut self, rms: f32) {
        if !self.boost || rms < NOISE_FLOOR {
            return;
        }
        let want = (TARGET_RMS / rms).clamp(1.0, MAX_GAIN);
        // down fast (a loud word must not clip), up slowly (a breath must not be turned into a roar)
        self.gain = if want < self.gain { want } else { self.gain * 0.85 + want * 0.15 };
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
                let v = (self.sum / self.n as f32 * self.gain).clamp(-1.0, 1.0);
                out.push((v * 32767.0) as i16);
                (self.sum, self.n) = (0.0, 0);
            }
        }
        let rms = if count == 0 { 0.0 } else { (energy / count as f32).sqrt() };
        let heard = rms * self.gain;
        self.follow(rms);
        heard
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
fn start_mic(name: String, boost: bool, stop: Arc<AtomicBool>, audio: UnboundedSender<Vec<u8>>, level: Arc<AtomicU32>) -> Result<u32, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    thread::Builder::new()
        .name("firevoice-mic".into())
        .spawn(move || {
            let open = || -> Result<(cpal::Stream, u32), String> {
                let device = input_device(&name)?;
                let cfg = device.default_input_config().map_err(|e| format!("The microphone could not be opened ({e})."))?;
                let (mut mix, rate) = Downmix::new(cfg.channels() as usize, cfg.sample_rate(), boost);
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

// ---------------------------------------------------------------------------------------------- the app being dictated into

/// The program that has the keyboard focus: (its executable's name without ".exe", its window title). Read when a
/// dictation starts, so the text can suit the app (and the history says where it went). None where it cannot be read.
fn foreground_app() -> Option<(String, String)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut title = [0u16; 512];
            let n = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32).max(0) as usize;
            let title = String::from_utf16_lossy(&title[..n]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return Some((String::new(), title));
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0;
            CloseHandle(h);
            let path = if ok { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() };
            let exe = std::path::Path::new(&path).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            Some((exe, title))
        }
    }
    #[cfg(not(windows))]
    {
        // X11: the active window's class and title, through xprop (on most desktops); Wayland does not say
        let id = std::process::Command::new("xprop").args(["-root", "_NET_ACTIVE_WINDOW"]).output().ok()?;
        let id = String::from_utf8_lossy(&id.stdout).split_whitespace().last()?.to_string();
        let out = std::process::Command::new("xprop").args(["-id", &id, "WM_CLASS", "_NET_WM_NAME"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let quoted = |line: &str| -> Vec<String> { line.split('"').skip(1).step_by(2).map(|x| x.to_string()).collect() };
        let class = text.lines().find(|l| l.starts_with("WM_CLASS")).and_then(|l| quoted(l).last().cloned()).unwrap_or_default();
        let title = text.lines().find(|l| l.starts_with("_NET_WM_NAME")).map(|l| quoted(l).join("")).unwrap_or_default();
        Some((class, title))
    }
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

/// Text that could not be typed is not lost: it goes on the clipboard, and the overlay says so.
fn rescue(app: &AppHandle, text: &str, why: &str) {
    log::error!("dictation: could not insert text: {why}");
    let saved = arboard::Clipboard::new().and_then(|mut c| c.set_text(text.to_string())).is_ok();
    let msg = if saved {
        "FireVoice could not type into this program. Your text is on the clipboard: paste it with Ctrl+V."
    } else {
        "FireVoice could not type into this program. Your text is in the dictation history."
    };
    show_overlay(app);
    emit_state(app, "error", Some(msg.into()));
    hide_overlay_later(app, Duration::from_millis(4500));
}

impl Typist {
    fn start(app: &AppHandle, paste: bool) -> Typist {
        let (tx, rx) = mpsc::channel::<String>();
        let app = app.clone();
        thread::Builder::new()
            .name("firevoice-type".into())
            .spawn(move || {
                let mut enigo = match Enigo::new(&Settings::default()) {
                    Ok(e) => Some(e),
                    Err(e) => {
                        log::error!("dictation: cannot type into other programs: {e}");
                        None
                    }
                };
                let mut failed = String::new();
                for text in rx {
                    if !failed.is_empty() {
                        // once a piece failed, the rest joins it on the clipboard rather than being typed around the hole
                        failed.push_str(&text);
                        rescue(&app, failed.trim_end(), "an earlier piece failed");
                        continue;
                    }
                    let Some(e) = enigo.as_mut() else {
                        failed.push_str(&text);
                        rescue(&app, failed.trim_end(), "no keyboard access");
                        continue;
                    };
                    // wait for the hotkey's own keys to come up (hold-to-talk, or a slow finger on a toggle)
                    let t0 = Instant::now();
                    while modifiers_down() && t0.elapsed() < Duration::from_secs(20) {
                        thread::sleep(Duration::from_millis(15));
                    }
                    let r = if paste { paste_text(e, &text) } else { type_text(e, &text) };
                    if let Err(why) = r {
                        failed.push_str(&text);
                        rescue(&app, failed.trim_end(), &why);
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

/// The text selected in the focused program, through the clipboard (which is put back): Ctrl+C, then whatever lands
/// there. "" when nothing is selected. Waits for the hotkey's keys to come up first, or Ctrl+C would be another chord.
fn grab_selection() -> String {
    let t0 = Instant::now();
    while modifiers_down() && t0.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(15));
    }
    let Ok(mut clip) = arboard::Clipboard::new() else { return String::new() };
    let before = clip.get_text().ok();
    let marker = format!("\u{2063}firevoice-{}", t0.elapsed().as_nanos());
    if clip.set_text(marker.clone()).is_err() {
        return String::new();
    }
    let copied = Enigo::new(&Settings::default()).ok().and_then(|mut e| {
        e.key(Key::Control, Direction::Press).ok()?;
        let r = e.key(Key::Unicode('c'), Direction::Click);
        e.key(Key::Control, Direction::Release).ok()?;
        r.ok()
    });
    let mut got = String::new();
    if copied.is_some() {
        let t1 = Instant::now();
        while t1.elapsed() < Duration::from_millis(450) {
            thread::sleep(Duration::from_millis(25));
            if let Ok(t) = clip.get_text() {
                if t != marker {
                    got = t;
                    break;
                }
            }
        }
    }
    match before {
        Some(b) => {
            let _ = clip.set_text(b);
        }
        None => {
            let _ = clip.clear();
        }
    }
    got
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
async fn run(app: &AppHandle, cfg: &Config, target: (String, String), command: bool, stop: Arc<AtomicBool>, cancel: Arc<AtomicBool>) -> Result<Option<ResultEvent>, String> {
    let engine_down = "FireVoice's voice engine is not running. Open FireVoice and wait until it is ready.";
    let level = Arc::new(AtomicU32::new(0));
    let mic_stop = Arc::new(AtomicBool::new(false));
    let (audio_tx, mut audio_rx): (UnboundedSender<Vec<u8>>, UnboundedReceiver<Vec<u8>>) = unbounded_channel();
    // the microphone opens first, so nothing said while the connection is made is lost
    let (name, stop2) = (cfg.mic.clone(), mic_stop.clone());
    let level2 = level.clone();
    let boost = cfg.boost_quiet;
    let rate = tokio::task::spawn_blocking(move || start_mic(name, boost, stop2, audio_tx, level2)).await.map_err(|e| e.to_string())??;
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
    let realtime = cfg.mode != "onstop" && !command;
    let mut start = serde_json::json!({
        "type": "start", "language": cfg.language, "keyterms": cfg.keyterms, "commands": cfg.commands, "fillers": cfg.fillers,
        "refine": !realtime, "sample_rate": rate, "app": target.0, "app_title": target.1, "history": cfg.history,
        "mode": if command { "command" } else { "dictation" },
    });
    if let (Some(extra), Some(obj)) = (cfg.extra.as_object(), start.as_object_mut()) {
        for (k, v) in extra {
            obj.entry(k.clone()).or_insert(v.clone());
        }
    }
    tx.send(Message::Text(start.to_string().into())).await.map_err(|e| e.to_string())?;

    // a command's result replaces the selection in one go, so it is always pasted
    let typist = Typist::start(app, cfg.insert == "paste" || command);
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
                            // command mode: the selection is read now, once the keys are up (it is still selected)
                            let stop_msg = if command {
                                let selection = tokio::task::spawn_blocking(grab_selection).await.unwrap_or_default();
                                serde_json::json!({"type": "stop", "selection": selection}).to_string()
                            } else {
                                r#"{"type":"stop"}"#.to_string()
                            };
                            tx.send(Message::Text(stop_msg.into())).await.map_err(|_| engine_down.to_string())?;
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

fn start(app: &AppHandle, locked: bool, command: bool) {
    let st = app.state::<Dictation>();
    let cfg = lock(&st.config).clone();
    let (stop, cancel) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    {
        let mut s = lock(&st.session);
        if s.is_some() {
            return;
        }
        *s = Some(Session { stop: stop.clone(), cancel: cancel.clone(), started: Instant::now(), locked, command });
    }
    // which program the words go to: read before the overlay appears (it never takes the focus, but be sure)
    let target = foreground_app().unwrap_or_default();
    show_overlay(app);
    emit_state(app, "starting", None);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = run(&app, &cfg, target, command, stop, cancel).await;
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
    if active(app) { stop(app, false) } else { start(app, false, false) }
}

fn on_hotkey(app: &AppHandle, state: ShortcutState, command: bool) {
    let st = app.state::<Dictation>();
    let hold = lock(&st.config).activation == "hold";
    match (hold, state) {
        (true, ShortcutState::Pressed) => {
            // a tap while hands-free ends it (and its release is not a new dictation)
            if lock(&st.session).as_ref().is_some_and(|s| s.locked) {
                *lock(&st.swallow_release) = true;
                stop(app, false);
                return;
            }
            // a second tap right after a quick one: hands-free until the next tap
            let double = lock(&st.last_tap).take().is_some_and(|t| t.elapsed() < DOUBLE_TAP);
            start(app, double, command);
        }
        (true, ShortcutState::Released) => {
            if std::mem::take(&mut *lock(&st.swallow_release)) {
                return;
            }
            let (locked, short) = lock(&st.session).as_ref().map(|s| (s.locked, s.started.elapsed() < MIN_HOLD)).unwrap_or((false, false));
            if locked {
                return;
            }
            if short {
                *lock(&st.last_tap) = Some(Instant::now());
            }
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
            if active(app) { stop(app, false) } else { start(app, false, command) }
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
    for old in std::mem::take(&mut *lock(&st.hotkeys)) {
        let _ = shortcuts.unregister(old.as_str());
    }
    let mut error = None;
    if config.enabled && !config.hotkey.trim().is_empty() {
        match shortcuts.on_shortcut(config.hotkey.as_str(), |app, _shortcut, event| on_hotkey(app, event.state, false)) {
            Ok(()) => lock(&st.hotkeys).push(config.hotkey.clone()),
            Err(e) => {
                log::warn!("dictation: cannot register {}: {e}", config.hotkey);
                error = Some("This key combination is taken by another program, or cannot be used. Choose another one.".to_string());
            }
        }
    }
    let cmd = config.command_hotkey.trim();
    if config.enabled && !cmd.is_empty() && cmd != config.hotkey.trim() {
        match shortcuts.on_shortcut(cmd, |app, _shortcut, event| on_hotkey(app, event.state, true)) {
            Ok(()) => lock(&st.hotkeys).push(cmd.to_string()),
            Err(e) => {
                log::warn!("dictation: cannot register the command hotkey {cmd}: {e}");
                error = error.or(Some("The command mode key combination is taken by another program, or cannot be used. Choose another one.".to_string()));
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
