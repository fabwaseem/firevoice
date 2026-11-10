mod backend;
mod updater;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(backend::Backend::default())
        .manage(updater::Updates::default())
        .invoke_handler(tauri::generate_handler![
            backend::backend_info,
            backend::backend_start,
            backend::backend_stop,
            backend::backend_logs,
            backend::backend_setup,
            updater::update_check,
            updater::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building FireVoice");

    app.run(|handle, event| {
        // A backend the app started goes away with the app; one the user started stays up.
        if let tauri::RunEvent::Exit = event {
            backend::stop(&handle.state::<backend::Backend>());
        }
    });
}
