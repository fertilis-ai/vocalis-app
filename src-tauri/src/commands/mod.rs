mod app;
mod config;
mod dictation;
mod fs;
mod inject;
mod keychain;
mod logging;
mod models;
mod people;
pub(crate) mod speech;

pub use app::*;
pub use config::*;
pub use dictation::*;
pub use fs::*;
pub use inject::*;
pub use keychain::*;
pub use logging::*;
pub use models::*;
pub use people::*;
pub use speech::*;

/// Expand a leading `~/` to the user's home directory.
pub(crate) fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.display(), &path[1..]);
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_expands_home_prefix() {
        let home = dirs::home_dir().unwrap();
        let expanded = expand_tilde("~/foo/bar.txt");
        assert_eq!(expanded, format!("{}/foo/bar.txt", home.display()));
    }

    #[test]
    fn expand_tilde_leaves_absolute_paths_alone() {
        assert_eq!(expand_tilde("/tmp/foo"), "/tmp/foo");
    }

    #[test]
    fn expand_tilde_leaves_bare_tilde_alone() {
        // Only `~/` is expanded; a bare `~` or `~user` form is passed through.
        assert_eq!(expand_tilde("~"), "~");
    }
}
