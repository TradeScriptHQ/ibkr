use tauri::utils::{
    acl::{capability::Capability, resolved::Resolved, ExecutionContext},
    platform::Target,
};

fn development_permissions() -> Resolved {
    let manifests =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.dev.conf.json")).unwrap();
    let capabilities = config["app"]["security"]["capabilities"]
        .as_array()
        .expect("development capabilities are configured")
        .iter()
        .map(|value| {
            let capability: Capability =
                serde_json::from_value(value.clone()).expect("development capability is inlined");
            (capability.identifier.clone(), capability)
        })
        .collect();
    Resolved::resolve(&manifests, capabilities, Target::current()).unwrap()
}

#[test]
fn development_credentials_page_permission_only_allows_the_local_main_workstation() {
    let resolved = development_permissions();
    let grants = resolved
        .allowed_commands
        .get("open_credentials_page")
        .expect("the fixed credentials page command is registered in development");
    assert!(!grants.is_empty());
    let mut local = false;
    let mut remote = false;
    for grant in grants {
        assert!(grant.windows.iter().any(|pattern| pattern.matches("main")));
        assert!(!grant
            .windows
            .iter()
            .any(|pattern| pattern.matches("untrusted")));
        assert!(grant.webviews.is_empty());
        match &grant.context {
            ExecutionContext::Local => local = true,
            ExecutionContext::Remote { url } => {
                remote = true;
                assert!(url.test(&"http://localhost:3000/".parse().unwrap()));
                for rejected in [
                    "http://127.0.0.1:3000/",
                    "http://localhost:3001/",
                    "https://localhost:3000/",
                    "https://console.tradescript.dev/",
                ] {
                    assert!(
                        !url.test(&rejected.parse().unwrap()),
                        "unexpected development origin: {rejected}"
                    );
                }
            }
        }
    }
    assert!(local, "the configured devUrl requires a Local grant");
    assert!(remote, "the development HTTP origin must also be explicit");
}

#[test]
fn development_window_commands_allow_the_local_main_window() {
    let resolved = development_permissions();
    // Tauri classifies the configured devUrl as Local, even though its URL is HTTP.
    // Remote-only grants therefore cannot authorize titlebar dragging in development.
    for command in [
        "plugin:window|start_dragging",
        "plugin:window|inner_position",
        "plugin:window|outer_position",
        "plugin:window|minimize",
        "plugin:window|toggle_maximize",
        "plugin:window|close",
    ] {
        let grants = resolved
            .allowed_commands
            .get(command)
            .expect("development window command is registered");
        let local_grants: Vec<_> = grants
            .iter()
            .filter(|grant| matches!(grant.context, ExecutionContext::Local))
            .collect();
        assert!(!local_grants.is_empty(), "no local grant for {command}");
        for grant in local_grants {
            assert!(grant.windows.iter().any(|pattern| pattern.matches("main")));
            assert!(!grant
                .windows
                .iter()
                .any(|pattern| pattern.matches("untrusted")));
            assert!(grant.webviews.is_empty());
        }
    }
}

#[test]
fn development_does_not_grant_desktop_update_commands() {
    let resolved = development_permissions();
    assert!(resolved.has_app_acl);
    for command in ["check_update", "install_update"] {
        assert!(
            !resolved.allowed_commands.contains_key(command),
            "development must not grant {command}"
        );
    }
}
