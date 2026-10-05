use tauri::menu::{Menu, MenuItem, MenuItemKind};

pub(super) const MENU_ID: &str = "about-terminal";

fn unexpected_default_layout() -> tauri::Error {
    std::io::Error::other("Unexpected default About menu layout").into()
}

pub(super) fn install<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    menu: &Menu<R>,
) -> tauri::Result<()> {
    // Tauri 2.11.5 Menu::default places About first in the macOS app submenu
    // and first in the identified Help submenu elsewhere. Preserve that slot
    // and every other item; macOS predefined About does not emit MenuEvent.
    #[cfg(target_os = "macos")]
    let submenu = match menu.items()?.into_iter().next() {
        Some(MenuItemKind::Submenu(submenu)) => submenu,
        _ => return Err(unexpected_default_layout()),
    };
    #[cfg(not(target_os = "macos"))]
    let submenu = match menu.get(tauri::menu::HELP_SUBMENU_ID) {
        Some(MenuItemKind::Submenu(submenu)) => submenu,
        _ => return Err(unexpected_default_layout()),
    };
    let original = match submenu.items()?.into_iter().next() {
        Some(MenuItemKind::Predefined(item)) => item,
        _ => return Err(unexpected_default_layout()),
    };
    let about = MenuItem::with_id(app, MENU_ID, original.text()?, true, None::<&str>)?;
    submenu.remove(&original)?;
    submenu.insert(&about, 0)
}
