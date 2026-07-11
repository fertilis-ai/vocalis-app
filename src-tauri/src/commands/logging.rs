use std::fs;
use std::path::{Path, PathBuf};

use super::app_data_dir;

// Log files live in ~/.vocalis/logs/. The webview logger writes daily files
// (vocalis-YYYY-MM-DD.log) — the file name is caller-supplied, so every
// command guards against path traversal.

fn logs_dir() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("logs"))
}

fn validate_filename(filename: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("Invalid filename".to_string());
    }
    Ok(())
}

fn append_line_at(dir: &Path, filename: &str, line: &str) -> Result<(), String> {
    validate_filename(filename)?;

    fs::create_dir_all(dir).map_err(|e| format!("Failed to create logs directory: {}", e))?;

    let log_path = dir.join(filename);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to open log file: {}", e))?;

    use std::io::Write;
    writeln!(file, "{}", line).map_err(|e| format!("Failed to write to log file: {}", e))
}

/// Append a line to a log file in ~/.vocalis/logs/
#[tauri::command]
pub async fn append_log_file(filename: String, line: String) -> Result<(), String> {
    append_line_at(&logs_dir()?, &filename, &line)
}

/// Read a log file from ~/.vocalis/logs/ (empty string if missing)
#[tauri::command]
pub async fn read_log_file(filename: String) -> Result<String, String> {
    validate_filename(&filename)?;

    let log_path = logs_dir()?.join(&filename);
    if !log_path.exists() {
        return Ok(String::new());
    }

    fs::read_to_string(&log_path).map_err(|e| format!("Failed to read log file: {}", e))
}

/// List log files in ~/.vocalis/logs/
#[tauri::command]
pub async fn list_log_files() -> Result<Vec<String>, String> {
    let logs_dir = logs_dir()?;
    if !logs_dir.exists() {
        return Ok(Vec::new());
    }

    let entries =
        fs::read_dir(&logs_dir).map_err(|e| format!("Failed to read logs directory: {}", e))?;

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                files.push(name.to_string());
            }
        }
    }

    files.sort();
    Ok(files)
}

/// Clear a log file in ~/.vocalis/logs/
#[tauri::command]
pub async fn clear_log_file(filename: String) -> Result<(), String> {
    validate_filename(&filename)?;

    let log_path = logs_dir()?.join(&filename);
    if log_path.exists() {
        fs::write(&log_path, "").map_err(|e| format!("Failed to clear log file: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_creates_dir_and_appends_lines() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");

        append_line_at(&logs, "vocalis-2026-07-09.log", "first").unwrap();
        append_line_at(&logs, "vocalis-2026-07-09.log", "second").unwrap();

        let content = fs::read_to_string(logs.join("vocalis-2026-07-09.log")).unwrap();
        assert_eq!(content, "first\nsecond\n");
    }

    #[test]
    fn traversal_filenames_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../evil.log", "a/b.log", "a\\b.log", ""] {
            assert!(append_line_at(dir.path(), bad, "x").is_err());
        }
    }
}
