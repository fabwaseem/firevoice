mod autostart;
mod backend;
mod cloud;
mod datafolders;
mod dictation;
mod updater;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

/// Bring the main window back (from the tray, or from behind other windows).
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// FireVoice draws its own title bar, so Windows would otherwise give the window a 1-pixel border line along the top
/// and square corners: ask for Windows 11's rounded corners and no border colour (older Windows ignores both).
#[cfg(windows)]
fn window_frame(app: &AppHandle) {
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND};
    let Some(w) = app.get_webview_window("main") else { return };
    let Ok(hwnd) = w.hwnd() else { return };
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let round = DWMWCP_ROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE as u32, (&round as *const i32).cast(), 4);
        let none: u32 = DWMWA_COLOR_NONE;
        DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR as u32, (&none as *const u32).cast(), 4);
    }
}
#[cfg(not(windows))]
fn window_frame(_app: &AppHandle) {}

/// The tray icon: FireVoice stays reachable while its window is closed (dictation keeps working from there).
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open FireVoice", true, None::<&str>)?;
    let dictate = MenuItem::with_id(app, "dictate", "Start or stop dictation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit FireVoice", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &dictate, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("firevoice")
        .tooltip("FireVoice")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "dictate" => dictation::toggle(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // one FireVoice at a time: starting it again shows the one that is running (it may be in the tray)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        // the app log keeps what explains a problem (starts, updates, errors) without debug chatter pushing it out
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) { log::LevelFilter::Debug } else { log::LevelFilter::Info })
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(backend::Backend::default())
        .manage(updater::Updates::default())
        .manage(dictation::Dictation::default())
        .manage(cloud::Cloud::default())
        .manage(cloud::Login::default())
        .invoke_handler(tauri::generate_handler![
            autostart::autostart_status,
            autostart::autostart_set,
            backend::backend_info,
            backend::backend_start,
            backend::backend_stop,
            backend::backend_logs,
            backend::backend_setup,
            backend::backend_finish_setup,
            backend::backend_extras_status,
            updater::update_check,
            updater::update_install,
            updater::update_download,
            updater::update_status,
            dictation::dictation_configure,
            dictation::dictation_toggle,
            dictation::dictation_cancel,
            dictation::dictation_mics,
            cloud::cloud_status,
            cloud::cloud_hello,
            cloud::cloud_consent,
            cloud::cloud_track,
            cloud::cloud_error,
            cloud::cloud_erase,
            cloud::cloud_login_start,
            cloud::cloud_login_cancel,
            cloud::cloud_sign_out,
            cloud::cloud_me,
            cloud::cloud_open,
            cloud::cloud_feedback,
            cloud::cloud_license,
            cloud::cloud_activate,
        ])
        .on_window_event(|window, event| {
            // with dictation on, closing the main window only hides it: the hotkey keeps working from the tray
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && dictation::stays_in_tray(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // where the user's data lives, for "delete all FireVoice data" in the uninstaller
            datafolders::record(app.handle());
            if let Err(e) = tray(app.handle()) {
                log::warn!("no tray icon: {e}");
            }
            window_frame(app.handle());
            // start with the computer (on unless the user turned it off); started that way, stay in the tray
            autostart::sync(app.handle());
            // usage sharing, accounts and feedback (FireVoice cloud): loads, counts the launch, sends in the background
            cloud::start(app.handle());
            if !autostart::started_at_login() {
                show_main(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FireVoice");

    app.run(|handle, event| {
        // A backend the app started goes away with the app; one the user started stays up.
        if let tauri::RunEvent::Exit = event {
            cloud::track(handle, "app.quit", serde_json::Value::Null);
            cloud::save_queue(handle);
            backend::stop_setup(&handle.state::<backend::Backend>());
            backend::stop(&handle.state::<backend::Backend>());
        }
    });
}
