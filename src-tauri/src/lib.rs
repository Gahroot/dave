//! DAVE desktop shell: bundles Node + the existing server and points a
//! webview at its loopback URL so the same-origin/CSRF guard works unchanged.
mod paths;
mod server;

use server::{Event, Status, Supervisor};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use std::sync::{Arc, Mutex};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";

/// Polled by the local loading page (only it has the capability).
#[tauri::command]
fn status(sup: State<'_, Supervisor>) -> Status {
    sup.status()
}

/// Restart the server after a failure (local loading page only).
#[tauri::command]
fn retry(app: AppHandle, sup: State<'_, Supervisor>) {
    let sup = sup.inner().clone();
    std::thread::spawn(move || start_server(&app, &sup));
}

fn start_server(app: &AppHandle, sup: &Supervisor) {
    let handle = app.clone();
    sup.start(move |event| on_server_event(&handle, event));
}

fn on_server_event(app: &AppHandle, event: Event) {
    let Some(win) = app.get_webview_window(MAIN) else { return };
    match event {
        Event::Healthy(port) => {
            if let Ok(url) = Url::parse(&server::server_url(port)) {
                let _ = win.navigate(url);
            }
        }
        Event::Failed => {
            // Back to the local page; it polls `status` and shows the error.
            let on_local = win.url().map(|u| is_local_app_url(&u)).unwrap_or(false);
            if !on_local {
                if let Ok(url) = local_page_url() {
                    let _ = win.navigate(url);
                }
            }
        }
    }
}

fn local_page_url() -> Result<Url, url::ParseError> {
    // frontendDist is served over the custom protocol in both dev and release.
    Url::parse("tauri://localhost/index.html")
}

fn is_local_app_url(url: &Url) -> bool {
    url.scheme() == "tauri" || (url.scheme() == "about" && url.path() == "blank")
}

fn is_server_url(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && port != 0
        && url.port() == Some(port)
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
}

/// Media-capture policy. WebKit does not pass the requesting origin through
/// wry, so the decision uses the window's last committed top-level URL (only
/// the local page and the server origin can ever load there). Microphone is
/// granted only to the server's own loopback origin; everything else is denied.
fn permission_decision(kind: PermissionKind, page: Option<&Url>, port: u16) -> PermissionResponse {
    match (kind, page) {
        (PermissionKind::Microphone, Some(url)) if is_server_url(url, port) => PermissionResponse::Allow,
        _ => PermissionResponse::Deny,
    }
}

/// Allow the local page and the server origin; open other http(s) externally.
fn allow_navigation(app: &AppHandle, sup: &Supervisor, url: &Url) -> bool {
    if is_local_app_url(url) || is_server_url(url, sup.port()) {
        return true;
    }
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&reload, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    // Replace the default View submenu (if any) with one that has Reload.
    for item in menu.items()? {
        if let Some(sub) = item.as_submenu() {
            if sub.text()? == "View" {
                menu.remove(sub)?;
            }
        }
    }
    menu.insert(&view, 3)?;
    Ok(menu)
}

fn create_window(app: &AppHandle, sup: &Supervisor) -> tauri::Result<()> {
    let nav_app = app.clone();
    let nav_sup = sup.clone();
    let new_app = app.clone();
    let new_sup = sup.clone();
    let perm_sup = sup.clone();
    // Last committed top-level URL, updated on every page load start.
    let page: Arc<Mutex<Option<Url>>> = Arc::new(Mutex::new(None));
    let load_page = Arc::clone(&page);
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("DAVE")
        .inner_size(1360.0, 900.0)
        .min_inner_size(960.0, 640.0)
        .on_navigation(move |url| allow_navigation(&nav_app, &nav_sup, url))
        .on_page_load(move |_webview, payload| {
            if let PageLoadEvent::Started = payload.event() {
                if let Ok(mut current) = load_page.lock() {
                    *current = Some(payload.url().clone());
                }
            }
        })
        .on_permission_request(move |_webview, kind| {
            let current = page.lock().ok().and_then(|g| g.clone());
            permission_decision(kind, current.as_ref(), perm_sup.port())
        })
        // Let HTML5 drag-and-drop reach the page (voice panel document drop)
        // instead of Tauri's native file-drop handler.
        .disable_drag_drop_handler()
        .on_new_window(move |url, _features| {
            // target=_blank / window.open: same-origin loads in the main window,
            // everything else goes to the default browser.
            if is_server_url(&url, new_sup.port()) {
                if let Some(w) = new_app.get_webview_window(MAIN) {
                    let _ = w.navigate(url);
                }
            } else {
                allow_navigation(&new_app, &new_sup, &url);
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

fn install_signal_handlers(app: &AppHandle) {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            // Routes through RunEvent::Exit, which stops the server group.
            app.exit(0);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![status, retry])
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == "reload" {
                if let Some(w) = app.get_webview_window(MAIN) {
                    let _ = w.reload();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let resource_dir = app.path().resource_dir()?;
            let sup = Supervisor::new(resource_dir);
            app.manage(sup.clone());
            install_signal_handlers(&handle);
            create_window(&handle, &sup)?;
            std::thread::spawn(move || start_server(&handle, &sup));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DAVE");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            // stop() blocks this thread (normally ~0.1 s, up to the 8 s grace
            // before SIGKILL); hide the window so it never shows a beachball.
            // Runs for both events; the second call is a no-op (child taken).
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.hide();
            }
            if let Some(sup) = app.try_state::<Supervisor>() {
                sup.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("valid url")
    }

    #[test]
    fn microphone_only_for_server_origin() {
        let allow = |k, u: &str| permission_decision(k, Some(&url(u)), 4317) == PermissionResponse::Allow;
        assert!(allow(PermissionKind::Microphone, "http://127.0.0.1:4317/#voice"));
        assert!(allow(PermissionKind::Microphone, "http://localhost:4317/"));
        assert!(!allow(PermissionKind::Microphone, "http://127.0.0.1:9999/"));
        assert!(!allow(PermissionKind::Microphone, "https://127.0.0.1:4317/"));
        assert!(!allow(PermissionKind::Microphone, "http://example.com:4317/"));
        assert!(!allow(PermissionKind::Microphone, "tauri://localhost/index.html"));
        assert!(!allow(PermissionKind::Camera, "http://127.0.0.1:4317/"));
        assert!(!allow(PermissionKind::Geolocation, "http://127.0.0.1:4317/"));
        assert_eq!(permission_decision(PermissionKind::Microphone, None, 4317), PermissionResponse::Deny);
        assert_eq!(
            permission_decision(PermissionKind::Microphone, Some(&url("http://127.0.0.1:0/")), 0),
            PermissionResponse::Deny
        );
    }
}
