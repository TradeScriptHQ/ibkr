use tauri::utils::{
    acl::{resolved::Resolved, ExecutionContext},
    platform::Target,
};

#[test]
fn compiled_update_permissions_only_allow_the_workstation_origin_and_window() {
    // Exercise Tauri's generated permission manifests and resolver, including
    // custom command registration (core:default does not grant app commands).
    let manifests =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    let resolved = Resolved::resolve(&manifests, capabilities, Target::current()).unwrap();
    assert!(resolved.has_app_acl);
    for command in [
        "check_update",
        "install_update",
        "plugin:window|start_dragging",
        "plugin:window|minimize",
        "plugin:window|toggle_maximize",
        "plugin:window|close",
    ] {
        let grants = resolved
            .allowed_commands
            .get(command)
            .expect("desktop command is registered");
        assert!(!grants.is_empty());
        for grant in grants {
            assert!(grant.windows.iter().any(|pattern| pattern.matches("main")));
            assert!(!grant
                .windows
                .iter()
                .any(|pattern| pattern.matches("untrusted")));
            assert!(grant.webviews.is_empty());
            let ExecutionContext::Remote { url } = &grant.context else {
                panic!("desktop commands must be restricted to the workstation origin");
            };
            assert!(url.test(&"http://127.0.0.1:43871/".parse().unwrap()));
            for other in [
                "http://127.0.0.1:43872/",
                "http://localhost:43871/",
                "https://127.0.0.1:43871/",
                "https://example.com/",
            ] {
                assert!(
                    !url.test(&other.parse().unwrap()),
                    "unexpected origin: {other}"
                );
            }
        }
    }
}
