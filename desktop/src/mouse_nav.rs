//! Native macOS mouse thumb-button navigation.
//!
//! WKWebView does not forward auxiliary mouse buttons (3/4, back/forward) to the
//! DOM: `auxclick` support for these buttons landed only in Safari 18.2
//! (webkit.org/b/273946), and even `mousedown` doesn't fire for special
//! buttons in Tauri's WKWebView (github.com/tauri-apps/tauri/issues/10936).
//!
//! This installs a local NSEvent monitor that catches `OtherMouseDown` for
//! button 3 (back) and 4 (forward) and injects navigation into the webview via
//! eval() — the same pattern the update overlay uses (shell.rs).
//!
//! The monitor consumes the event (returns nil) for buttons 3/4 so the DOM
//! `onauxclick` handler (kept as a browser/PWA fallback) doesn't double-fire
//! on newer WKWebView. Other buttons (middle-click etc.) pass through untouched.

use tauri::{AppHandle, Manager};

use crate::shell::MAIN_WINDOW;

/// Map a macOS `NSEvent.buttonNumber` to a navigation direction, or `None`
/// for non-thumb buttons. Pure and unit-testable. Takes `i64` (not
/// `NSInteger`) so the function compiles on all platforms — `NSInteger` is
/// `isize` on 64-bit, and `NSEvent::buttonNumber()` returns `NSInteger`,
/// which converts via `as i64`.
fn thumb_direction(button: i64) -> Option<&'static str> {
    match button {
        3 => Some("back"),
        4 => Some("forward"),
        _ => None,
    }
}

/// JS injected into the webview. Uses `window.__pantokenNav` (exposed by
/// `client/src/main.ts`). The `&&` guard makes this a no-op during early page
/// load before the bridge attaches.
fn nav_js(dir: &str) -> String {
    format!(r#"window.__pantokenNav && window.__pantokenNav("{dir}");"#)
}

#[cfg(target_os = "macos")]
pub fn install(app: AppHandle) {
    use std::ptr::{self, NonNull};

    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};

    // OtherMouseDown covers standard mouse thumb buttons (button 3/4).
    // NSEventTypeSwipe (some HID devices) is a follow-up.
    let mask = NSEventMask::OtherMouseDown;
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the block a live, valid NSEvent for the duration
        // of the callback; the borrow is confined to this block body.
        let event_ref = unsafe { event.as_ref() };
        if let Some(dir) = thumb_direction(event_ref.buttonNumber() as i64) {
            if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                let _ = w.eval(nav_js(dir));
            }
            // Consume: return nil so the DOM never sees a duplicate.
            ptr::null_mut()
        } else {
            // Pass through middle-click and other buttons untouched.
            event.as_ptr()
        }
    });

    let token = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
    // The monitor copies the block (standard Obj-C block semantics), so the
    // RcBlock can drop here. The returned token is the sole strong reference to
    // the monitor — dropping it would release and deallocate the monitor, so we
    // forget it to keep the monitor alive for the app's lifetime (one window,
    // one monitor, no teardown needed — the process exit deallocates it).
    if let Some(token) = token {
        std::mem::forget(token);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: AppHandle) {}

#[cfg(test)]
mod tests {
    use super::thumb_direction;

    #[test]
    fn maps_thumb_buttons() {
        assert_eq!(thumb_direction(3), Some("back"));
        assert_eq!(thumb_direction(4), Some("forward"));
    }

    #[test]
    fn ignores_other_buttons() {
        assert_eq!(thumb_direction(0), None);
        assert_eq!(thumb_direction(1), None);
        assert_eq!(thumb_direction(2), None);
        assert_eq!(thumb_direction(5), None);
    }
}
