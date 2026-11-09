mod backend;

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
        .manage(backend::Backend::default())
        .invoke_handler(tauri::generate_handler![
            backend::backend_info,
            backend::backend_start,
            backend::backend_stop,
            backend::backend_logs,
            backend::backend_setup,
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
