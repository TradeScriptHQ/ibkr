use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{webview::NewWindowResponse, AppHandle, Url, WebviewUrl, WebviewWindowBuilder};

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

fn popout_url_allowed(url: &Url, origin: &Url) -> bool {
    super::navigation_allowed(url, origin)
        && url.path() == "/workspace-popout.html"
        && url.query().is_none()
        && url.fragment().is_none()
}

pub fn open(
    app: &AppHandle,
    url: Url,
    features: tauri::webview::NewWindowFeatures,
    origin: &Url,
) -> NewWindowResponse<tauri::Wry> {
    if !popout_url_allowed(&url, origin) {
        return NewWindowResponse::Deny;
    }
    let window_origin = origin.clone();
    let label = format!(
        "workspace-panel-{}",
        NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
    );
    // The requested opener configuration preserves the SDK's retained DOM and controllers.
    let builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External("about:blank".parse().expect("valid blank window URL")),
    )
    .window_features(features)
    .title(&app.package_info().name)
    .min_inner_size(360.0, 240.0)
    .disable_drag_drop_handler()
    .on_navigation(move |target| {
        target.as_str() == "about:blank" || popout_url_allowed(target, &window_origin)
    })
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
    });
    match builder.build() {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => NewWindowResponse::Deny,
    }
}

#[cfg(test)]
mod tests {
    use super::popout_url_allowed;
    use tauri::Url;

    #[test]
    fn detached_windows_only_open_the_blank_workspace_page_on_the_current_origin() {
        for address in ["http://localhost:3000", "http://127.0.0.1:43871"] {
            let origin: Url = address.parse().unwrap();
            assert!(popout_url_allowed(
                &origin.join("/workspace-popout.html").unwrap(),
                &origin
            ));
            for path in [
                "/",
                "/api/v1/session/bootstrap",
                "/workspace-popout.html?x=1",
                "/workspace-popout.html#x",
            ] {
                assert!(!popout_url_allowed(&origin.join(path).unwrap(), &origin));
            }
            for blocked in [
                "http://localhost:3001/workspace-popout.html",
                "https://localhost:3000/workspace-popout.html",
                "https://example.com/workspace-popout.html",
                "http://user@localhost:3000/workspace-popout.html",
                "about:blank",
            ] {
                assert!(
                    !popout_url_allowed(&blocked.parse().unwrap(), &origin),
                    "{blocked}"
                );
            }
        }
    }
}
