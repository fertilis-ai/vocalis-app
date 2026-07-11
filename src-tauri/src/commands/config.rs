use std::fs;
use std::path::{Path, PathBuf};

use super::app_data_dir;

// config.yaml is a schemaless passthrough: the webview owns the shape
// (Zod-validated there), Rust just converts YAML <-> JSON value.

fn config_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("config.yaml"))
}

fn read_config_at(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read config: {}", e))?;
    serde_yaml::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
}

fn save_config_at(path: &Path, config: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let yaml =
        serde_yaml::to_string(config).map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(path, yaml).map_err(|e| format!("Failed to write config: {}", e))
}

/// Read ~/.vocalis/config.yaml as a JSON value (empty object if missing)
#[tauri::command]
pub async fn read_config() -> Result<serde_json::Value, String> {
    read_config_at(&config_path()?)
}

/// Save a JSON value as YAML to ~/.vocalis/config.yaml
#[tauri::command]
pub async fn save_config(config: serde_json::Value) -> Result<(), String> {
    save_config_at(&config_path()?, &config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_round_trips_through_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");

        let config = json!({
            "privacyMode": true,
            "appearance": { "theme": "dark", "hue": "teal" },
            "routing": { "streamingAsr": "local.zipformer-en" },
            "cache": { "ttsMaxBytes": 2147483648u64 },
        });

        save_config_at(&path, &config).unwrap();
        let loaded = read_config_at(&path).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn missing_config_reads_as_empty_object() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = read_config_at(&dir.path().join("config.yaml")).unwrap();
        assert_eq!(loaded, serde_json::json!({}));
    }

    #[test]
    fn invalid_yaml_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        fs::write(&path, "foo: [unclosed").unwrap();
        assert!(read_config_at(&path).is_err());
    }
}
