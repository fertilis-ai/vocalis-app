use std::thread;
use std::time::Duration;

use arboard::Clipboard;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_millis(180);

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;

    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    pub(super) const COMMAND_KEY: u16 = 0x37;
    pub(super) const V_KEY: u16 = 0x09;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    pub(super) fn accessibility_is_trusted(prompt: bool) -> bool {
        // AXTrustedCheckOptionPrompt asks macOS to show its standard Accessibility
        // settings prompt. The dictionary must stay alive for the synchronous call.
        if prompt {
            let key = CFString::new("AXTrustedCheckOptionPrompt");
            let options = CFDictionary::from_CFType_pairs(&[(
                key.as_CFType(),
                CFBoolean::true_value().as_CFType(),
            )]);
            // Safety: the Core Foundation dictionary is valid for the duration of
            // this synchronous macOS accessibility API call.
            unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef().cast()) }
        } else {
            // Safety: AXIsProcessTrusted has no preconditions.
            unsafe { AXIsProcessTrusted() }
        }
    }

    pub(super) fn paste() -> Result<(), String> {
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "failed to create macOS input event source")?;
        let command_down = CGEvent::new_keyboard_event(source.clone(), COMMAND_KEY, true)
            .map_err(|_| "failed to create Command key event")?;
        command_down.post(CGEventTapLocation::HID);

        let v_down = CGEvent::new_keyboard_event(source.clone(), V_KEY, true)
            .map_err(|_| "failed to create V key-down event")?;
        v_down.set_flags(CGEventFlags::CGEventFlagCommand);
        v_down.post(CGEventTapLocation::HID);

        let v_up = CGEvent::new_keyboard_event(source.clone(), V_KEY, false)
            .map_err(|_| "failed to create V key-up event")?;
        v_up.set_flags(CGEventFlags::CGEventFlagCommand);
        v_up.post(CGEventTapLocation::HID);

        let command_up = CGEvent::new_keyboard_event(source, COMMAND_KEY, false)
            .map_err(|_| "failed to create Command key-up event")?;
        command_up.post(CGEventTapLocation::HID);
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use std::mem::size_of;

    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_CONTROL,
    };

    pub(super) const V_KEY: VIRTUAL_KEY = 0x56;

    /// Windows has no Accessibility permission gate for synthetic input.
    pub(super) fn accessibility_is_trusted(_prompt: bool) -> bool {
        true
    }

    fn key(vk: VIRTUAL_KEY, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    pub(super) fn paste() -> Result<(), String> {
        let inputs = [
            key(VK_CONTROL, 0),
            key(V_KEY, 0),
            key(V_KEY, KEYEVENTF_KEYUP),
            key(VK_CONTROL, KEYEVENTF_KEYUP),
        ];
        // Safety: `inputs` is a valid, fully initialised INPUT array for the
        // duration of this synchronous call.
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        // UIPI blocks injection into elevated windows; SendInput then reports
        // fewer events than requested.
        if sent as usize != inputs.len() {
            return Err("failed to send Ctrl+V (target window may be elevated)".into());
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub(super) fn accessibility_is_trusted(_prompt: bool) -> bool {
        false
    }

    pub(super) fn paste() -> Result<(), String> {
        Err("automatic paste is not supported on this platform".into())
    }
}

use platform::{accessibility_is_trusted, paste};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionResult {
    /// `true` only when the paste keystroke (Cmd+V / Ctrl+V) was posted.
    pub injected: bool,
    /// Text is always placed on the clipboard before an injection attempt.
    pub copied: bool,
    pub accessibility_trusted: bool,
}

fn restore_clipboard_after_paste(previous: Option<String>, pasted: String) {
    thread::spawn(move || {
        thread::sleep(CLIPBOARD_RESTORE_DELAY);
        let Some(previous) = previous else {
            return;
        };
        let Ok(mut clipboard) = Clipboard::new() else {
            return;
        };
        // Do not overwrite a clipboard item the person copied immediately
        // after dictating. The temporary text is restored only if untouched.
        if clipboard.get_text().ok().as_deref() == Some(pasted.as_str()) {
            let _ = clipboard.set_text(previous);
        }
    });
}

fn notify_copy_only(app: &AppHandle) {
    let _ = app
        .notification()
        .builder()
        .title("Dictation copied")
        .body("Enable Accessibility for Vocalis to paste dictation automatically.")
        .show();
}

/// Clipboard-swap injection for the frontmost application. If macOS
/// Accessibility is unavailable, text remains copied and a notification tells
/// the user how to enable automatic pasting.
#[tauri::command]
pub fn inject_text(app: AppHandle, text: String) -> Result<InjectionResult, String> {
    if text.trim().is_empty() {
        return Ok(InjectionResult {
            injected: false,
            copied: false,
            accessibility_trusted: accessibility_is_trusted(false),
        });
    }

    let mut clipboard =
        Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;
    let previous = clipboard.get_text().ok();
    clipboard
        .set_text(text.clone())
        .map_err(|error| format!("failed to copy dictation: {error}"))?;

    if !accessibility_is_trusted(true) {
        notify_copy_only(&app);
        return Ok(InjectionResult {
            injected: false,
            copied: true,
            accessibility_trusted: false,
        });
    }

    match paste() {
        Ok(()) => {
            restore_clipboard_after_paste(previous, text);
            Ok(InjectionResult {
                injected: true,
                copied: true,
                accessibility_trusted: true,
            })
        }
        Err(error) => {
            notify_copy_only(&app);
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_key_codes_match_the_hardware_layout() {
        assert_eq!(super::platform::COMMAND_KEY, 0x37);
        assert_eq!(super::platform::V_KEY, 0x09);
    }

    #[cfg(windows)]
    #[test]
    fn windows_virtual_key_for_v() {
        assert_eq!(super::platform::V_KEY, u16::from(b'V'));
    }
}
