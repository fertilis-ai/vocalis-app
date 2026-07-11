pub mod audio;
mod commands;
pub mod engines;
pub mod pipeline;
pub mod registry;
mod state;

use commands::*;
use state::SpeechState;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "tray-open", "Open Vocalis", true, None::<&str>)?;
    let privacy = CheckMenuItem::with_id(
        app,
        "tray-privacy",
        "Privacy mode",
        true,
        false,
        None::<&str>,
    )?;
    let polish = CheckMenuItem::with_id(
        app,
        "tray-polish",
        "Polish dictation",
        true,
        false,
        None::<&str>,
    )?;
    let stop_dictation = MenuItem::with_id(
        app,
        "tray-stop-dictation",
        "Stop Dictation",
        true,
        Some("Alt+Escape"),
    )?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Vocalis", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &privacy, &polish, &stop_dictation, &quit])?;
    // The main window mirrors the settings store into these via
    // tray_set_toggles; without it the checkmarks drift from the real state.
    app.manage(TrayToggles {
        privacy: privacy.clone(),
        polish: polish.clone(),
    });

    let mut tray = TrayIconBuilder::with_id("vocalis")
        .menu(&menu)
        .tooltip("Vocalis")
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "tray-privacy" => {
                let _ = app.emit(
                    "dictation-settings",
                    serde_json::json!({ "togglePrivacy": true }),
                );
            }
            "tray-polish" => {
                let _ = app.emit(
                    "dictation-settings",
                    serde_json::json!({ "togglePolish": true }),
                );
            }
            "tray-stop-dictation" => force_stop_dictation(app),
            "tray-quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SpeechState::default())
        .manage(registry::download::DownloadRegistry::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Info-level logging in debug builds, Warn in release so
            // production issues remain diagnosable.
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Info
            } else {
                log::LevelFilter::Warn
            };
            use tauri::Manager;
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .build(),
            )?;

            if let Err(e) = init_app_data_dir() {
                log::error!("Failed to initialize app data directory: {e}");
            }

            setup_tray(app)?;
            configure_hotkey(&app.handle(), "Alt+Space", "hold").map_err(std::io::Error::other)?;

            if let Some(main) = app.get_webview_window("main") {
                let window = main.clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_home_dir,
            get_app_data_dir,
            init_app_data_dir,
            tray_set_toggles,
            // fs
            read_file,
            write_file,
            read_file_base64,
            write_file_base64,
            delete_path,
            rename_path,
            copy_file,
            create_directory,
            path_exists,
            list_files,
            read_directory,
            reveal_in_folder,
            // config
            read_config,
            save_config,
            // keychain
            store_api_key,
            get_api_key,
            delete_api_key,
            get_all_api_keys,
            // logging
            append_log_file,
            read_log_file,
            list_log_files,
            clear_log_file,
            // speech (local engines)
            audio_input_devices,
            asr_pipeline_start,
            asr_pipeline_stop,
            session_pipeline_start,
            session_pipeline_stop,
            import_audio,
            session_import,
            session_import_cancel,
            dictation_start,
            dictation_finalize,
            dictation_cancel,
            dictation_configure_hotkey,
            dictation_force_stop,
            inject_text,
            tts_synthesize,
            tts_cache_size,
            tts_cache_evict,
            tts_save_to_library,
            vad_pipeline_start,
            vad_analyze_file,
            asr_transcribe_file,
            asr_transcribe_file_streaming,
            punctuate_text,
            speaker_compare_files,
            speaker_identify_file,
            diarize_file,
            kws_pipeline_start,
            kws_analyze_file,
            kws_default_keywords,
            langid_file,
            separate_file,
            record_start,
            record_stop,
            record_cancel,
            audio_file_info,
            // people (enrollment)
            enroll_record_start,
            enroll_person,
            // models (catalog + downloads)
            models_catalog,
            models_installed,
            model_download,
            model_download_cancel,
            model_delete,
            model_add_custom,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
