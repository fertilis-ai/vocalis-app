use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

use super::expand_tilde;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

/// Read a file's content
#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    let path = expand_tilde(&path);
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

/// Write content to a file (creates parent directories)
#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    let path = expand_tilde(&path);
    let path = Path::new(&path);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }

    fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
}

/// Read a file and return its contents base64-encoded
#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let path = expand_tilde(&path);
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Write binary data (base64-encoded) to a file
#[tauri::command]
pub async fn write_file_base64(path: String, data_base64: String) -> Result<(), String> {
    use base64::Engine;
    let path = expand_tilde(&path);
    let path = Path::new(&path);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("Failed to decode base64 data: {}", e))?;
    fs::write(path, bytes).map_err(|e| format!("Failed to write file: {}", e))
}

/// Delete a file or directory
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    let path = expand_tilde(&path);
    let path = Path::new(&path);

    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(path).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

/// Rename/move a file or directory
#[tauri::command]
pub async fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let old_path = expand_tilde(&old_path);
    let new_path = expand_tilde(&new_path);

    let old = Path::new(&old_path);
    let new = Path::new(&new_path);

    if !old.exists() {
        return Err(format!("Source path does not exist: {}", old_path));
    }

    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }

    fs::rename(old, new).map_err(|e| format!("Failed to rename: {}", e))
}

/// Copy a file to a new location (creates parent directories)
#[tauri::command]
pub async fn copy_file(source_path: String, dest_path: String) -> Result<(), String> {
    let source = expand_tilde(&source_path);
    let dest = expand_tilde(&dest_path);
    let dest = Path::new(&dest);

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }

    fs::copy(&source, dest).map_err(|e| format!("Failed to copy file: {}", e))?;
    Ok(())
}

/// Create a directory
#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    let path = expand_tilde(&path);
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {}", e))
}

/// Check if a path exists
#[tauri::command]
pub fn path_exists(path: String) -> bool {
    let path = expand_tilde(&path);
    Path::new(&path).exists()
}

/// List files in a directory, optionally filtered by extension.
/// Returns filenames without extension (e.g. "my-session" for "my-session.json").
#[tauri::command]
pub fn list_files(dir: String, extension: Option<String>) -> Result<Vec<String>, String> {
    let dir = expand_tilde(&dir);
    let path = Path::new(&dir);

    if !path.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let entry_path = entry.path();

        if entry_path.is_file() {
            let matches = if let Some(ref ext) = extension {
                entry_path.extension().and_then(|e| e.to_str()) == Some(ext)
            } else {
                true
            };

            if matches {
                if let Some(stem) = entry_path.file_stem() {
                    files.push(stem.to_string_lossy().to_string());
                }
            }
        }
    }

    files.sort();
    Ok(files)
}

/// Read a directory tree recursively (with max depth)
#[tauri::command]
pub async fn read_directory(path: String, max_depth: Option<u32>) -> Result<Vec<FileNode>, String> {
    let path = expand_tilde(&path);
    let path = Path::new(&path);

    if !path.exists() {
        return Err(format!("Path does not exist: {}", path.display()));
    }

    if !path.is_dir() {
        return Err(format!("Path is not a directory: {}", path.display()));
    }

    let max_depth = max_depth.unwrap_or(3);
    read_directory_recursive(path, 0, max_depth)
}

fn read_directory_recursive(
    path: &Path,
    current_depth: u32,
    max_depth: u32,
) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();

    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and common ignore patterns
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
            continue;
        }

        let is_directory = entry_path.is_dir();
        let children = if is_directory && current_depth < max_depth {
            Some(read_directory_recursive(
                &entry_path,
                current_depth + 1,
                max_depth,
            )?)
        } else if is_directory {
            Some(Vec::new()) // Empty children, can be loaded on demand
        } else {
            None
        };

        nodes.push(FileNode {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_directory,
            children,
        });
    }

    // Sort: directories first, then alphabetically
    nodes.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(nodes)
}

/// Reveal a file in the OS file manager (Finder/Explorer)
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    let path = expand_tilde(&path);

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg("-R").arg(&path).spawn();

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer")
        .arg(format!("/select,{}", path))
        .spawn();

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let result = {
        // No standard "reveal" on Linux — open the containing directory
        let parent = Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(path.clone());
        Command::new("xdg-open").arg(parent).spawn()
    };

    result.map_err(|e| format!("Failed to reveal in folder: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_files_filters_by_extension_and_strips_it() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.json"), "{}").unwrap();
        fs::write(dir.path().join("b.json"), "{}").unwrap();
        fs::write(dir.path().join("c.txt"), "x").unwrap();

        let files = list_files(
            dir.path().to_string_lossy().to_string(),
            Some("json".to_string()),
        )
        .unwrap();
        assert_eq!(files, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn list_files_missing_dir_is_empty() {
        let files = list_files("/nonexistent/vocalis-test".to_string(), None).unwrap();
        assert!(files.is_empty());
    }
}
