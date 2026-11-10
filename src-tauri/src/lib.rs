mod backend;
mod migrate;
mod updater;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // an older identifier's folders (settings, engine runtime, logs) move to this one before anything opens them
    let moved = migrate::previous_identifiers("app.fabwaseem.firevoice");
    let app = tauri::Builder::default()
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
        .setup(move |_| {
            for m in &moved {
                log::info!("app folder: {m}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FireVoice");

    app.run(|handle, event| {
        // A backend the app started goes away with the app; one the user started stays up.
        if let tauri::RunEvent::Exit = event {
            backend::stop(&handle.state::<backend::Backend>());
        }
    });
}
