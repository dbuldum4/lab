//! The 21 colour themes from the web app, expressed as GPUI colours.

mod generated;

use gpui::{Hsla, Rgba, rgba};

pub use generated::THEMES;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ThemeId(pub &'static str);

/// Raw `0xRRGGBBAA` values, one per CSS custom property.
#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub paper: u32,
    pub ink: u32,
    pub muted: u32,
    pub quiet: u32,
    pub line: u32,
    pub selection: u32,
    pub heading: u32,
    pub text_strong: u32,
    pub text_soft: u32,
    pub text_dim: u32,
    pub surface_input: u32,
    pub surface: u32,
    pub surface_raised: u32,
    pub surface_control: u32,
    pub surface_selected: u32,
    pub surface_hover: u32,
    pub border_subtle: u32,
    pub border: u32,
    pub border_strong: u32,
    pub focus: u32,
    pub primary: u32,
    pub primary_ink: u32,
    pub shadow: u32,
    pub subtle_highlight: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct ThemeDef {
    pub id: ThemeId,
    pub label: &'static str,
    pub detail: &'static str,
    pub swatches: [u32; 3],
    pub palette: Palette,
}

pub const DEFAULT_THEME: &str = "dark";

pub fn theme_by_id(id: &str) -> Option<&'static ThemeDef> {
    THEMES.iter().find(|theme| theme.id.0 == id)
}

pub fn theme_or_default(id: &str) -> &'static ThemeDef {
    theme_by_id(id).unwrap_or(&THEMES[0])
}

/// Colours resolved once per theme change so render code can copy them freely.
#[derive(Clone, Copy, Debug)]
pub struct Colors {
    pub paper: Hsla,
    pub ink: Hsla,
    pub muted: Hsla,
    pub quiet: Hsla,
    pub line: Hsla,
    pub selection: Hsla,
    pub heading: Hsla,
    pub text_strong: Hsla,
    pub text_soft: Hsla,
    pub text_dim: Hsla,
    pub surface_input: Hsla,
    pub surface: Hsla,
    pub surface_raised: Hsla,
    pub surface_control: Hsla,
    pub surface_selected: Hsla,
    pub surface_hover: Hsla,
    pub border_subtle: Hsla,
    pub border: Hsla,
    pub border_strong: Hsla,
    pub focus: Hsla,
    pub primary: Hsla,
    pub primary_ink: Hsla,
    pub shadow: Hsla,
    pub subtle_highlight: Hsla,
    pub callout_tip: Hsla,
    pub callout_warning: Hsla,
    pub callout_important: Hsla,
}

fn c(value: u32) -> Hsla {
    let color: Rgba = rgba(value);
    color.into()
}

impl Colors {
    pub fn from_theme(theme: &ThemeDef) -> Self {
        let p = &theme.palette;
        Self {
            paper: c(p.paper),
            ink: c(p.ink),
            muted: c(p.muted),
            quiet: c(p.quiet),
            line: c(p.line),
            selection: c(p.selection),
            heading: c(p.heading),
            text_strong: c(p.text_strong),
            text_soft: c(p.text_soft),
            text_dim: c(p.text_dim),
            surface_input: c(p.surface_input),
            surface: c(p.surface),
            surface_raised: c(p.surface_raised),
            surface_control: c(p.surface_control),
            surface_selected: c(p.surface_selected),
            surface_hover: c(p.surface_hover),
            border_subtle: c(p.border_subtle),
            border: c(p.border),
            border_strong: c(p.border_strong),
            focus: c(p.focus),
            primary: c(p.primary),
            primary_ink: c(p.primary_ink),
            shadow: c(p.shadow),
            subtle_highlight: c(p.subtle_highlight),
            // Callout accents are fixed in the web stylesheet across themes.
            callout_tip: c(0x64826cff),
            callout_warning: c(0x9a7a49ff),
            callout_important: c(0x8a6173ff),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn has_every_web_theme_with_unique_ids() {
        assert_eq!(THEMES.len(), 21);
        let ids: HashSet<_> = THEMES.iter().map(|theme| theme.id.0).collect();
        assert_eq!(ids.len(), THEMES.len());
        assert_eq!(THEMES[0].id.0, DEFAULT_THEME);
    }

    #[test]
    fn unknown_theme_falls_back_to_dark() {
        assert_eq!(theme_or_default("nope").id.0, "dark");
        assert_eq!(theme_or_default("nord").label, "Nord");
    }
}
