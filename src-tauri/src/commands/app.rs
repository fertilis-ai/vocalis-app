use std::path::PathBuf;

use tauri::menu::CheckMenuItem;

/// Handles to the tray's check items so the webview can mirror the real
/// settings into them (they otherwise only flip on direct tray clicks).
pub struct TrayToggles {
    pub privacy: CheckMenuItem<tauri::Wry>,
    pub polish: CheckMenuItem<tauri::Wry>,
}

#[tauri::command]
pub fn tray_set_toggles(
    toggles: tauri::State<TrayToggles>,
    privacy: bool,
    polish: bool,
) -> Result<(), String> {
    toggles
        .privacy
        .set_checked(privacy)
        .map_err(|e| e.to_string())?;
    toggles
        .polish
        .set_checked(polish)
        .map_err(|e| e.to_string())
}

/// Subdirectories created under ~/.vocalis/ at startup — spec/spec.md §4.
const APP_SUBDIRS: &[&str] = &[
    "models",
    "people",
    "voices",
    "chats",
    "sessions",
    "playground",
    "recordings",
    "cache/tts",
    "logs",
    "exports",
];

pub fn app_data_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("could not resolve home directory")?;
    Ok(home.join(".vocalis"))
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("could not resolve home directory")?;
    Ok(home.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_app_data_dir() -> Result<String, String> {
    Ok(app_data_dir()?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn init_app_data_dir() -> Result<String, String> {
    let root = app_data_dir()?;
    for sub in APP_SUBDIRS {
        let dir = root.join(sub);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    }
    Ok(root.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_data_dir_is_under_home() {
        let dir = app_data_dir().unwrap();
        assert!(dir.ends_with(".vocalis"));
    }
}
