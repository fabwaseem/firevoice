//! Start FireVoice when the user signs in, quietly in the tray, so dictation is ready without opening anything.
//!
//! On by default; Settings turns it off. The choice is kept in `<app config>/autostart.json`, and the system entry
//! (Windows: the per-user `Run` key; Linux: `~/.config/autostart/firevoice.desktop`) is written again on every start,
//! so it always points at the FireVoice that is installed now (after an update or a move) and comes back if
//! something removed it. When the user turns FireVoice off in Windows' own startup list (Task Manager, Settings >
//! Apps > Startup) or in their desktop's autostart settings, that is taken as their choice and the toggle follows.
//! Development builds never register themselves.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The argument the startup entry passes: start in the tray, without showing the window.
pub const FLAG: &str = "--autostart";

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    enabled: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct Status {
    /// this system can start FireVoice at sign-in
    supported: bool,
    /// the user's choice (on unless turned off)
    enabled: bool,
    /// the system entry is in place and points at this FireVoice
    registered: bool,
    /// a development build: the choice is kept but nothing is registered
    dev: bool,
}

/// FireVoice was started by the sign-in entry (so it stays in the tray).
pub fn started_at_login() -> bool {
    std::env::args().any(|a| a == FLAG)
}

fn saved_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("autostart.json"))
}

fn load(app: &AppHandle) -> Saved {
    saved_path(app).and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(app: &AppHandle, enabled: bool) {
    let Some(p) = saved_path(app) else { return };
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string(&Saved { enabled: Some(enabled) }).unwrap_or_default();
    if fs::write(&tmp, body).is_ok() && fs::rename(&tmp, &p).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

const DEV: bool = cfg!(debug_assertions);

/// Bring the system entry in line with the user's choice. Called on every start.
pub fn sync(app: &AppHandle) {
    if !os::SUPPORTED {
        return;
    }
    let mut enabled = load(app).enabled.unwrap_or(true);
    if enabled && os::turned_off_by_user() {
        log::info!("autostart: turned off in the system's startup settings; following that");
        enabled = false;
        save(app, false);
    }
    if DEV {
        return;
    }
    if let Err(e) = os::apply(enabled) {
        log::warn!("autostart: could not {} the startup entry: {e}", if enabled { "write" } else { "remove" });
    }
}

fn status(app: &AppHandle) -> Status {
    let enabled = os::SUPPORTED && load(app).enabled.unwrap_or(true);
    Status { supported: os::SUPPORTED, enabled, registered: os::SUPPORTED && os::registered(), dev: DEV }
}

#[tauri::command]
pub fn autostart_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<Status, String> {
    if !os::SUPPORTED {
        return Err("Starting with the computer is not available on this system.".into());
    }
    save(&app, enabled);
    if !DEV {
        if enabled {
            // turning it on here also turns it back on in the system's own startup list
            os::allow();
        }
        os::apply(enabled).map_err(|e| format!("Could not change the startup setting: {e}"))?;
    }
    log::info!("autostart: {}", if enabled { "on" } else { "off" });
    Ok(status(&app))
}

#[allow(dead_code)]
/// How the installed app is started: the path the user would run.
fn program() -> Option<PathBuf> {
    // an AppImage runs from a temporary mount; the file the user keeps is $APPIMAGE
    if let Some(p) = std::env::var_os("APPIMAGE").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(p));
    }
    std::env::current_exe().ok().map(|p| fs::canonicalize(&p).unwrap_or(p)).map(|p| {
        // canonicalize on Windows gives \\?\C:\..., which the Run key does not take
        let s = p.to_string_lossy();
        PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
    })
}

#[cfg(windows)]
mod os {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_ANY, RegCloseKey, RegCreateKeyExW,
        RegDeleteKeyValueW, RegGetValueW, RegSetValueExW,
    };

    pub const SUPPORTED: bool = true;
    const NAME: &str = "FireVoice";
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    fn w(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn command() -> Option<String> {
        super::program().map(|p| format!("\"{}\" {}", p.display(), super::FLAG))
    }

    fn get(sub: &str, name: &str) -> Option<Vec<u8>> {
        let (sub, name) = (w(sub), w(name));
        let mut size: u32 = 0;
        unsafe {
            if RegGetValueW(HKEY_CURRENT_USER, sub.as_ptr(), name.as_ptr(), RRF_RT_ANY, null_mut(), null_mut(), &mut size) != ERROR_SUCCESS {
                return None;
            }
            let mut buf = vec![0u8; size as usize];
            if RegGetValueW(HKEY_CURRENT_USER, sub.as_ptr(), name.as_ptr(), RRF_RT_ANY, null_mut(), buf.as_mut_ptr().cast(), &mut size) != ERROR_SUCCESS {
                return None;
            }
            buf.truncate(size as usize);
            Some(buf)
        }
    }

    fn get_string(sub: &str, name: &str) -> Option<String> {
        let b = get(sub, name)?;
        let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&u| u != 0).collect();
        Some(String::from_utf16_lossy(&units))
    }

    fn set_string(sub: &str, name: &str, value: &str) -> Result<(), String> {
        let (sub, name, data) = (w(sub), w(name), w(value));
        unsafe {
            let mut key: HKEY = null_mut();
            let r = RegCreateKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, null(), &mut key, null_mut());
            if r != ERROR_SUCCESS {
                return Err(format!("registry error {r}"));
            }
            let r = RegSetValueExW(key, name.as_ptr(), 0, REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32);
            RegCloseKey(key);
            if r != ERROR_SUCCESS {
                return Err(format!("registry error {r}"));
            }
        }
        Ok(())
    }

    fn delete(sub: &str, name: &str) -> Result<(), String> {
        let (sub, name) = (w(sub), w(name));
        let r = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, sub.as_ptr(), name.as_ptr()) };
        if r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND { Ok(()) } else { Err(format!("registry error {r}")) }
    }

    /// Windows' startup list (Task Manager > Startup apps) keeps its own on/off per entry: an odd first byte is off.
    pub fn turned_off_by_user() -> bool {
        get_string(RUN, NAME).is_some() && off_in_windows(NAME)
    }

    fn off_in_windows(name: &str) -> bool {
        get(APPROVED, name).is_some_and(|b| b.first().is_some_and(|x| x & 1 == 1))
    }

    /// Clear Windows' own "off" for FireVoice, so turning it on in FireVoice takes effect.
    pub fn allow() {
        let _ = delete(APPROVED, NAME);
    }

    pub fn registered() -> bool {
        let Some(want) = command() else { return false };
        get_string(RUN, NAME).is_some_and(|v| v.eq_ignore_ascii_case(&want)) && !off_in_windows(NAME)
    }

    pub fn apply(enabled: bool) -> Result<(), String> {
        if !enabled {
            return delete(RUN, NAME);
        }
        let want = command().ok_or("FireVoice's own path is unknown")?;
        if get_string(RUN, NAME).as_deref() == Some(want.as_str()) {
            return Ok(());
        }
        set_string(RUN, NAME, &want)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::System::Registry::REG_BINARY;

        fn set_binary(sub: &str, name: &str, data: &[u8]) {
            let (sub, name) = (w(sub), w(name));
            unsafe {
                let mut key: HKEY = null_mut();
                assert_eq!(RegCreateKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, null(), &mut key, null_mut()), ERROR_SUCCESS);
                assert_eq!(RegSetValueExW(key, name.as_ptr(), 0, REG_BINARY, data.as_ptr(), data.len() as u32), ERROR_SUCCESS);
                RegCloseKey(key);
            }
        }

        #[test]
        fn run_entry_and_windows_startup_switch() {
            let name = "FireVoiceAutostartTest";
            let cmd = r#""C:\Program Files\FireVoice\FireVoice.exe" --autostart"#;
            set_string(RUN, name, cmd).unwrap();
            assert_eq!(get_string(RUN, name).as_deref(), Some(cmd));
            assert!(!off_in_windows(name));
            set_binary(APPROVED, name, &[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // Task Manager: Disabled
            assert!(off_in_windows(name));
            set_binary(APPROVED, name, &[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // Enabled
            assert!(!off_in_windows(name));
            delete(APPROVED, name).unwrap();
            delete(RUN, name).unwrap();
            delete(RUN, name).unwrap(); // already gone is fine
            assert_eq!(get_string(RUN, name), None);
        }
    }
}

#[cfg(target_os = "linux")]
mod os {
    use std::fs;
    use std::path::PathBuf;

    pub const SUPPORTED: bool = true;

    fn file() -> Option<PathBuf> {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(base.join("autostart").join("firevoice.desktop"))
    }

    fn quote(p: &std::path::Path) -> String {
        // the desktop entry spec: a quoted argument escapes \ " ` $
        let mut s = String::from("\"");
        for c in p.to_string_lossy().chars() {
            if matches!(c, '\\' | '"' | '`' | '$') {
                s.push('\\');
            }
            s.push(c);
        }
        s.push('"');
        s
    }

    fn entry() -> Option<String> {
        let exec = format!("{} {}", quote(&super::program()?), super::FLAG);
        Some(format!(
            "[Desktop Entry]\nType=Application\nName=FireVoice\nComment=Dictation ready in the tray\nExec={exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
        ))
    }

    /// The desktop's autostart settings turn an entry off with Hidden=true or X-GNOME-Autostart-enabled=false.
    pub fn turned_off_by_user() -> bool {
        let Some(s) = file().and_then(|f| fs::read_to_string(f).ok()) else { return false };
        s.lines().map(str::trim).any(|l| l.eq_ignore_ascii_case("Hidden=true") || l.eq_ignore_ascii_case("X-GNOME-Autostart-enabled=false"))
    }

    pub fn allow() {}

    pub fn registered() -> bool {
        match (file().and_then(|f| fs::read_to_string(f).ok()), entry()) {
            (Some(have), Some(want)) => have == want,
            _ => false,
        }
    }

    pub fn apply(enabled: bool) -> Result<(), String> {
        let f = file().ok_or("no home folder")?;
        if !enabled {
            return match fs::remove_file(&f) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        let want = entry().ok_or("FireVoice's own path is unknown")?;
        if fs::read_to_string(&f).ok().as_deref() == Some(want.as_str()) {
            return Ok(());
        }
        if let Some(dir) = f.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(&f, want).map_err(|e| e.to_string())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod os {
    pub const SUPPORTED: bool = false;
    pub fn turned_off_by_user() -> bool {
        false
    }
    pub fn allow() {}
    pub fn registered() -> bool {
        false
    }
    pub fn apply(_enabled: bool) -> Result<(), String> {
        Ok(())
    }
}
