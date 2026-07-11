use std::collections::HashMap;

const KEYCHAIN_SERVICE: &str = "Vocalis";

/// Speech + LLM providers whose keys we look up in get_all_api_keys.
const PROVIDERS: &[&str] = &[
    "openai",
    "elevenlabs",
    "groq",
    "deepgram",
    "anthropic",
    "google",
    "openrouter",
];

/// Store an API key in the OS keychain
#[tauri::command]
pub async fn store_api_key(provider: String, key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &provider)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    entry
        .set_password(&key)
        .map_err(|e| format!("Failed to store key in keychain: {}", e))
}

/// Get an API key from the OS keychain. Returns None if not found.
#[tauri::command]
pub async fn get_api_key(provider: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &provider)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to read key from keychain: {}", e)),
    }
}

/// Delete an API key from the OS keychain. Idempotent (no error if missing).
#[tauri::command]
pub async fn delete_api_key(provider: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &provider)
        .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete key from keychain: {}", e)),
    }
}

/// Load all API keys from the OS keychain in one call.
#[tauri::command]
pub async fn get_all_api_keys() -> Result<HashMap<String, String>, String> {
    let mut keys = HashMap::new();
    for provider in PROVIDERS {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, provider)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
        match entry.get_password() {
            Ok(password) => {
                keys.insert(provider.to_string(), password);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => {
                log::warn!("Failed to read {} key from keychain: {}", provider, e);
            }
        }
    }
    Ok(keys)
}
