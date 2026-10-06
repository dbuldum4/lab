//! lab: a local-first Markdown notepad, native on macOS and Linux.

mod app;
mod backup;
mod commands;
mod editor;
mod markdown_info;
mod search;
mod text_ops;
mod theme;
mod ui;
mod vault;

use std::borrow::Cow;

use gpui::{
    App, AppContext as _, Bounds, Menu, MenuItem, TitlebarOptions, WindowBounds, WindowOptions,
    point, px, size,
};

use app::{LabApp, Quit};
use vault::Vault;

fn load_fonts(cx: &mut App) {
    let fonts: Vec<Cow<'static, [u8]>> = vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Italic.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-SemiBoldItalic.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Bold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-BoldItalic.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-SemiBold.ttf")),
    ];
    if let Err(err) = cx.text_system().add_fonts(fonts) {
        eprintln!("lab: could not load the bundled fonts: {err}");
    }
}

fn main() {
    let root = Vault::default_root();
    let vault = match Vault::open(&root) {
        Ok(vault) => vault,
        Err(err) => {
            eprintln!("lab: {err:#}");
            std::process::exit(1);
        }
    };

    gpui_platform::application().run(move |cx: &mut App| {
        load_fonts(cx);
        editor::bind_keys(cx);
        app::bind_keys(cx);
        cx.set_menus([Menu {
            name: "lab".into(),
            items: vec![MenuItem::action("Quit lab", Quit)],
            disabled: false,
        }]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        let bounds = Bounds::centered(None, size(px(1100.), px(820.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("lab".into()),
                appears_transparent: cfg!(target_os = "macos"),
                traffic_light_position: Some(point(px(14.), px(14.))),
            }),
            window_min_size: Some(size(px(420.), px(360.))),
            app_id: Some("lab".into()),
            ..Default::default()
        };
        let mut vault = Some(vault);
        let opened = cx.open_window(options, |window, cx| {
            let vault = vault.take().expect("the window opens once");
            cx.new(|cx| LabApp::new(vault, window, cx))
        });
        if let Err(err) = opened {
            eprintln!("lab: could not open a window: {err:#}");
            cx.quit();
        }
        cx.activate(true);
    });
}
