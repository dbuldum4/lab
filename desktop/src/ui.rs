//! Rendering for `LabApp`: the slash palette, outline, and notices.

use gpui::{
    AnyElement, BoxShadow, Context, Div, FontWeight, HighlightStyle, Hsla, InteractiveElement as _,
    IntoElement, MouseButton, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledText, Window, div, point,
    prelude::FluentBuilder as _, px,
};

use crate::app::{
    EditLink, ExportNote, InsertMath, LabApp, Mode, NewSession, NoticeKind, OpenHistory,
    OpenLanguage, OpenSearch, OpenSessions, OpenShortcuts, OpenStats, PaletteClose, PaletteConfirm,
    PaletteDown, PaletteNextField, PaletteUp, PickerKind, Quit, ToggleOutline, format_time,
};
use crate::commands::{CODE_LANGUAGES, SHORTCUTS, display_keys};
use crate::editor::view::{MONO, SANS};
use crate::markdown_info::{active_outline_index, document_stats, outline};
use crate::search::match_ranges;
use crate::theme::{Colors, THEMES};

const PALETTE_WIDTH: f32 = 384.;
const PALETTE_MAX_HEIGHT: f32 = 316.;
const NOTICES: &str = include_str!("../../THIRD_PARTY_NOTICES.md");

fn shadow(colors: &Colors, y: f32, blur: f32) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: colors.shadow,
        offset: point(px(0.), px(y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
        inset: false,
    }]
}

fn small(text: impl Into<SharedString>, color: Hsla) -> Div {
    div()
        .text_size(px(12.))
        .line_height(px(16.))
        .text_color(color)
        .child(text.into())
}

fn kbd(text: impl Into<SharedString>, colors: &Colors) -> Div {
    div()
        .flex_none()
        .px(px(5.))
        .py(px(1.))
        .rounded(px(4.))
        .border_1()
        .border_color(colors.border)
        .font_family(MONO)
        .text_size(px(10.))
        .text_color(colors.quiet)
        .child(text.into())
}

fn button(
    id: &'static str,
    label: &'static str,
    tone: Tone,
    colors: &Colors,
) -> gpui::Stateful<Div> {
    let (bg, border, color, hover_bg, hover_color) = match tone {
        Tone::Primary => (
            colors.primary,
            colors.primary,
            colors.primary_ink,
            colors.heading,
            colors.primary_ink,
        ),
        Tone::Danger => (
            colors.surface_control,
            gpui::rgb(0x573c3c).into(),
            gpui::rgb(0xcf9c9c).into(),
            colors.surface_hover,
            colors.heading,
        ),
        Tone::Plain => (
            colors.surface_control,
            colors.border,
            colors.text_soft,
            colors.surface_hover,
            colors.heading,
        ),
    };
    div()
        .id(id)
        .min_h(px(30.))
        .px(px(10.))
        .py(px(6.))
        .rounded(px(7.))
        .border_1()
        .border_color(border)
        .bg(bg)
        .text_size(px(11.))
        .text_color(color)
        .cursor_pointer()
        .hover(move |style| style.bg(hover_bg).text_color(hover_color))
        .child(label)
}

#[derive(Clone, Copy)]
enum Tone {
    Primary,
    Danger,
    Plain,
}

/// Text with search matches highlighted.
fn highlighted(text: &str, query: &str, colors: &Colors) -> Div {
    let style = HighlightStyle {
        color: Some(colors.surface),
        background_color: Some(colors.primary),
        ..Default::default()
    };
    let ranges: Vec<_> = match_ranges(text, query)
        .into_iter()
        .map(|range| (range, style))
        .collect();
    div().child(StyledText::new(text.to_string()).with_highlights(ranges))
}

impl LabApp {
    fn field_box(
        &self,
        prefix: Option<&'static str>,
        field: gpui::Entity<crate::editor::Editor>,
        window: &Window,
        cx: &Context<Self>,
    ) -> Div {
        let colors = self.colors;
        let focused = field.read(cx).focus_handle.is_focused(window);
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .py(px(8.))
            .rounded(px(8.))
            .border_1()
            .border_color(if focused { colors.focus } else { colors.border })
            .bg(colors.surface_input)
            .when_some(prefix, |this, prefix| {
                this.child(
                    div()
                        .font_family(MONO)
                        .text_size(px(14.))
                        .text_color(colors.muted)
                        .child(prefix),
                )
            })
            .child(div().flex_1().min_w_0().child(field))
            .child(kbd("Esc", &colors))
    }

    #[allow(clippy::too_many_arguments)]
    fn option_row(
        &self,
        index: usize,
        selected: bool,
        current: bool,
        label: AnyElement,
        detail: AnyElement,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let colors = self.colors;
        div()
            .id(("option", index))
            .flex()
            .items_baseline()
            .gap(px(16.))
            .min_h(px(38.))
            .px(px(10.))
            .py(px(9.))
            .rounded(px(8.))
            .when(selected, |this| this.bg(colors.surface_selected))
            .when(disabled, |this| this.opacity(0.62))
            .child(
                div()
                    .w(px(118.))
                    .flex_none()
                    .text_size(px(13.))
                    .text_color(if disabled {
                        colors.muted
                    } else {
                        colors.text_strong
                    })
                    .flex()
                    .gap(px(7.))
                    .child(label)
                    .when(current, |this| {
                        this.child(div().text_color(colors.muted).child("•"))
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(12.))
                    .text_color(if disabled { colors.quiet } else { colors.muted })
                    .child(detail),
            )
            .when(!disabled, |this| {
                this.on_mouse_move(cx.listener(move |this, _, _, cx| {
                    if let Some(palette) = &mut this.palette
                        && palette.selected != index
                    {
                        palette.selected = index;
                        cx.notify();
                    }
                }))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, window, cx| {
                        if let Some(palette) = &mut this.palette {
                            palette.selected = index;
                        }
                        this.confirm_selected(window, cx);
                        cx.stop_propagation();
                    }),
                )
            })
            .into_any_element()
    }

    fn list(&self, rows: Vec<AnyElement>, max_height: f32) -> AnyElement {
        div()
            .id("palette-list")
            .flex()
            .flex_col()
            .max_h(px(max_height))
            .overflow_y_scroll()
            .track_scroll(&self.palette_scroll)
            .p(px(5.))
            .children(rows)
            .into_any_element()
    }

    fn message(
        &self,
        title: impl Into<SharedString>,
        detail: impl Into<SharedString>,
    ) -> AnyElement {
        let colors = self.colors;
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .px(px(15.))
            .py(px(13.))
            .text_size(px(13.))
            .text_color(colors.text_soft)
            .child(title.into())
            .child(small(detail, colors.muted))
            .into_any_element()
    }

    fn header(&self, title: &'static str, detail: String) -> AnyElement {
        let colors = self.colors;
        div()
            .flex()
            .justify_between()
            .items_baseline()
            .px(px(14.))
            .pt(px(12.))
            .pb(px(4.))
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(colors.text_strong)
                    .child(title),
            )
            .child(small(detail, colors.muted))
            .into_any_element()
    }

    fn render_palette_body(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let colors = self.colors;
        let Some(palette) = &self.palette else {
            return div().into_any_element();
        };
        let selected = palette.selected;
        let field_query = self.field_text(cx);
        match &palette.mode {
            Mode::Commands { query, .. } => {
                let ranked = self.ranked_commands(query, cx);
                if ranked.is_empty() {
                    return self.message("No command", "Esc to return to the editor");
                }
                let mut selectable = 0;
                let rows = ranked
                    .into_iter()
                    .map(|item| {
                        let available = item.availability.available;
                        let index = if available { selectable } else { usize::MAX - selectable };
                        let is_selected = available && selectable == selected;
                        if available {
                            selectable += 1;
                        }
                        let detail = item.availability.reason.unwrap_or(item.command.detail);
                        self.option_row(
                            index,
                            is_selected,
                            false,
                            item.command.label.into_any_element(),
                            detail.into_any_element(),
                            !available,
                            cx,
                        )
                    })
                    .collect();
                self.list(rows, PALETTE_MAX_HEIGHT - 10.)
            }
            Mode::Search { index, results } => {
                let summary = if field_query.trim().is_empty() {
                    format!("{} local {}", index.len(), if index.len() == 1 { "session" } else { "sessions" })
                } else {
                    format!("{} {}", results.len(), if results.len() == 1 { "match" } else { "matches" })
                };
                let rows: Vec<AnyElement> = if field_query.trim().is_empty() {
                    vec![div().px(px(5.)).py(px(9.)).child(small("Search session names and the text of every local note.", colors.text_dim)).into_any_element()]
                } else if results.is_empty() {
                    vec![div().px(px(5.)).py(px(9.)).child(small(format!("No local notes match “{}”.", field_query.trim()), colors.text_dim)).into_any_element()]
                } else {
                    results
                        .iter()
                        .enumerate()
                        .map(|(i, result)| {
                            let current = result.document_id == self.session.id;
                            let kind = format!("{}{}", if current { "Current session · " } else { "" }, result.kind.label());
                            let excerpt = if result.excerpt.is_empty() { "Session name match".to_string() } else { result.excerpt.clone() };
                            div()
                                .id(("result", i))
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .px(px(10.))
                                .pt(px(9.))
                                .pb(px(10.))
                                .rounded(px(8.))
                                .when(i == selected, |this| this.bg(colors.surface_selected))
                                .child(
                                    div()
                                        .flex()
                                        .justify_between()
                                        .gap(px(12.))
                                        .child(highlighted(&result.name, &field_query, &colors).text_size(px(13.)).text_color(colors.text_strong))
                                        .child(div().flex_none().text_size(px(10.)).text_color(colors.muted).child(kind)),
                                )
                                .child(highlighted(&excerpt, &field_query, &colors).text_size(px(12.)).line_height(px(17.)).text_color(colors.text_dim))
                                .on_mouse_move(cx.listener(move |this, _, _, cx| {
                                    if let Some(p) = &mut this.palette
                                        && p.selected != i
                                    {
                                        p.selected = i;
                                        cx.notify();
                                    }
                                }))
                                .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, window, cx| {
                                    if let Some(p) = &mut this.palette {
                                        p.selected = i;
                                    }
                                    this.confirm_selected(window, cx);
                                    cx.stop_propagation();
                                }))
                                .into_any_element()
                        })
                        .collect()
                };
                div()
                    .flex()
                    .flex_col()
                    .p(px(7.))
                    .child(self.field_box(Some("/"), self.field.clone(), window, cx))
                    .child(div().px(px(5.)).pt(px(10.)).pb(px(4.)).child(small(summary, colors.text_dim)))
                    .child(self.list(rows, 200.))
                    .child(self.footer("↑↓ move · Enter open · Esc close · local only"))
                    .into_any_element()
            }
            Mode::Name => div()
                .flex()
                .flex_col()
                .gap(px(7.))
                .px(px(15.))
                .py(px(13.))
                .child(small("Session name", colors.text_soft))
                .child(self.field_box(None, self.field.clone(), window, cx))
                .child(small("Enter to save · Esc to cancel", colors.muted).text_size(px(11.)))
                .into_any_element(),
            Mode::Picker { kind, sessions } => {
                let matches = self.picker_matches(cx);
                let rows: Vec<AnyElement> = if matches.is_empty() {
                    let empty = if !field_query.is_empty() {
                        "No sessions match"
                    } else {
                        match kind {
                            PickerKind::Archives => "No archived sessions",
                            PickerKind::LinkSession => "No other sessions",
                            PickerKind::Sessions => "No sessions",
                        }
                    };
                    vec![self.message(empty, "Esc to return to the editor")]
                } else {
                    matches
                        .iter()
                        .enumerate()
                        .map(|(row, &index)| {
                            let session = &sessions[index];
                            let current = session.id == self.session.id;
                            let detail = match kind {
                                PickerKind::LinkSession => {
                                    if session.archived { "Archived · insert local link".to_string() } else { "Insert local link".to_string() }
                                }
                                _ if current => "Current session".to_string(),
                                _ if session.updated_at > 0 => format_time(session.updated_at),
                                _ => "Original session".to_string(),
                            };
                            let label = format!("{}{}", if session.pinned { "◆ " } else { "" }, session.name);
                            self.option_row(row, row == selected, current && *kind != PickerKind::LinkSession, label.into_any_element(), detail.into_any_element(), false, cx)
                        })
                        .collect()
                };
                let placeholder = match kind {
                    PickerKind::Sessions => "Sessions",
                    PickerKind::Archives => "Archived sessions",
                    PickerKind::LinkSession => "Link to a session",
                };
                div()
                    .flex()
                    .flex_col()
                    .child(self.header(placeholder, format!("{} {}", sessions.len(), if sessions.len() == 1 { "session" } else { "sessions" })))
                    .child(div().px(px(7.)).pt(px(6.)).child(self.field_box(None, self.field.clone(), window, cx)))
                    .child(self.list(rows, 220.))
                    .into_any_element()
            }
            Mode::Stats(stats) => {
                let items = [
                    ("Words", stats.words.to_string()),
                    ("Characters", stats.characters.to_string()),
                    ("Without spaces", stats.characters_no_spaces.to_string()),
                    ("Paragraphs", stats.paragraphs.to_string()),
                    ("Headings", stats.headings.to_string()),
                    ("Code blocks", stats.code_blocks.to_string()),
                    ("Reading time", format!("{} min", stats.reading_minutes)),
                ];
                let cell = |label: &'static str, value: String| {
                    div()
                        .flex_1()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .px(px(11.))
                        .py(px(8.))
                        .bg(colors.surface_raised)
                        .child(div().text_size(px(10.)).text_color(colors.muted).child(label))
                        .child(div().text_size(px(15.)).font_weight(FontWeight::MEDIUM).text_color(colors.text_strong).child(value))
                };
                let rows = items.chunks(2).map(|pair| {
                    let mut row = div().flex().gap(px(1.));
                    for (label, value) in pair {
                        row = row.child(cell(label, value.clone()));
                    }
                    if pair.len() == 1 {
                        row = row.child(div().flex_1().bg(colors.surface_raised));
                    }
                    row
                });
                div()
                    .flex()
                    .flex_col()
                    .px(px(14.))
                    .pt(px(12.))
                    .pb(px(14.))
                    .child(div().text_size(px(13.)).text_color(colors.text_strong).child("Document statistics"))
                    .child(small("Counts reflect the readable text in this note.", colors.muted).text_size(px(11.)).mt(px(3.)))
                    .child(
                        div()
                            .mt(px(12.))
                            .flex()
                            .flex_col()
                            .gap(px(1.))
                            .rounded(px(9.))
                            .border_1()
                            .border_color(colors.border_subtle)
                            .bg(colors.border_subtle)
                            .overflow_hidden()
                            .children(rows),
                    )
                    .into_any_element()
            }
            Mode::Shortcuts => {
                let rows = SHORTCUTS.iter().map(|shortcut| {
                    div()
                        .flex()
                        .justify_between()
                        .items_center()
                        .gap(px(16.))
                        .px(px(2.))
                        .py(px(7.))
                        .border_b_1()
                        .border_color(colors.border_subtle)
                        .child(div().text_size(px(12.)).text_color(colors.text_soft).child(shortcut.action))
                        .child(
                            div()
                                .px(px(6.))
                                .py(px(3.))
                                .rounded(px(5.))
                                .border_1()
                                .border_color(colors.border)
                                .bg(colors.surface_control)
                                .font_family(MONO)
                                .text_size(px(10.))
                                .text_color(colors.text_dim)
                                .child(display_keys(shortcut.keys)),
                        )
                        .into_any_element()
                });
                div()
                    .flex()
                    .flex_col()
                    .px(px(14.))
                    .pt(px(12.))
                    .pb(px(10.))
                    .child(div().text_size(px(13.)).text_color(colors.text_strong).child("Keyboard shortcuts"))
                    .child(small("The slash palette lists every command.", colors.muted).text_size(px(11.)).mt(px(3.)))
                    .child(div().id("shortcut-list").mt(px(7.)).max_h(px(240.)).overflow_y_scroll().children(rows))
                    .into_any_element()
            }
            Mode::Language => {
                let rows = CODE_LANGUAGES
                    .iter()
                    .enumerate()
                    .map(|(i, (id, label))| {
                        let detail = if id.is_empty() { "No fence identifier".to_string() } else { format!("```{id}") };
                        self.option_row(i, i == selected, false, (*label).into_any_element(), detail.into_any_element(), false, cx)
                    })
                    .collect();
                self.list(rows, PALETTE_MAX_HEIGHT - 10.)
            }
            Mode::Theme => {
                let matches = self.picker_matches(cx);
                let rows: Vec<AnyElement> = if matches.is_empty() {
                    vec![div().px(px(10.)).py(px(9.)).child(small(format!("No themes match “{}”.", field_query.trim()), colors.text_dim)).into_any_element()]
                } else {
                    matches
                        .iter()
                        .enumerate()
                        .map(|(row, &index)| {
                            let theme = &THEMES[index];
                            let current = theme.id == self.theme.id;
                            let swatches = div()
                                .flex()
                                .flex_none()
                                .overflow_hidden()
                                .rounded_full()
                                .border_1()
                                .border_color(colors.border_strong)
                                .children(theme.swatches.iter().map(|c| div().w(px(8.)).h(px(14.)).bg(gpui::rgba(*c))));
                            let label = div().flex().items_center().gap(px(9.)).child(swatches).child(theme.label).into_any_element();
                            let detail = if current { "Current" } else { theme.detail };
                            div()
                                .id(("theme", row))
                                .flex()
                                .items_center()
                                .gap(px(16.))
                                .min_h(px(38.))
                                .px(px(10.))
                                .py(px(9.))
                                .rounded(px(8.))
                                .when(row == selected, |this| this.bg(colors.surface_selected))
                                .child(div().w(px(176.)).flex_none().text_size(px(13.)).text_color(colors.text_strong).child(label))
                                .child(div().flex_1().min_w_0().text_size(px(12.)).text_color(colors.muted).child(detail))
                                .on_mouse_move(cx.listener(move |this, _, _, cx| {
                                    if let Some(p) = &mut this.palette
                                        && p.selected != row
                                    {
                                        p.selected = row;
                                        cx.notify();
                                    }
                                }))
                                .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, window, cx| {
                                    if let Some(p) = &mut this.palette {
                                        p.selected = row;
                                    }
                                    this.confirm_selected(window, cx);
                                    cx.stop_propagation();
                                }))
                                .into_any_element()
                        })
                        .collect()
                };
                let count = matches.len();
                div()
                    .flex()
                    .flex_col()
                    .p(px(7.))
                    .child(self.field_box(Some("◐"), self.field.clone(), window, cx))
                    .child(self.list(rows, 226.))
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .items_center()
                            .child(self.footer(&format!("{count} {} · ↑↓ move · Enter select", if count == 1 { "theme" } else { "themes" })))
                            .child(
                                div()
                                    .id("licenses")
                                    .mt(px(5.))
                                    .px(px(5.))
                                    .text_size(px(10.))
                                    .text_color(colors.muted)
                                    .cursor_pointer()
                                    .hover(|s| s.text_color(colors.text_strong))
                                    .child("Licenses")
                                    .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| {
                                        this.open_mode(Mode::Licenses, 0, window, cx);
                                        cx.stop_propagation();
                                    })),
                            ),
                    )
                    .into_any_element()
            }
            Mode::Backlinks(links) => {
                let matches = self.picker_matches(cx);
                let rows: Vec<AnyElement> = if matches.is_empty() {
                    vec![self.message("No backlinks yet", "Use /link-note in another session to create one")]
                } else {
                    matches
                        .iter()
                        .enumerate()
                        .map(|(row, &index)| {
                            let link = &links[index];
                            self.option_row(row, row == selected, false, link.name.clone().into_any_element(), link.excerpt.clone().into_any_element(), false, cx)
                        })
                        .collect()
                };
                div()
                    .flex()
                    .flex_col()
                    .child(self.header("Backlinks", format!("{} incoming {}", links.len(), if links.len() == 1 { "link" } else { "links" })))
                    .child(div().px(px(7.)).pt(px(6.)).child(self.field_box(None, self.field.clone(), window, cx)))
                    .child(self.list(rows, 210.))
                    .into_any_element()
            }
            Mode::History(versions) => {
                let matches = self.picker_matches(cx);
                let rows: Vec<AnyElement> = if matches.is_empty() {
                    vec![self.message("No saved versions yet", "Versions appear as you write and before replacing a note")]
                } else {
                    matches
                        .iter()
                        .enumerate()
                        .map(|(row, &index)| {
                            let version = &versions[index];
                            let words = document_stats(&version.markdown).words;
                            let detail = format!("{words} {} · Enter to restore", if words == 1 { "word" } else { "words" });
                            self.option_row(row, row == selected, false, format_time(version.created_at).into_any_element(), detail.into_any_element(), false, cx)
                        })
                        .collect()
                };
                div()
                    .flex()
                    .flex_col()
                    .child(self.header("Version history", format!("{} local {}", versions.len(), if versions.len() == 1 { "version" } else { "versions" })))
                    .child(div().px(px(7.)).pt(px(6.)).child(self.field_box(None, self.field.clone(), window, cx)))
                    .child(self.list(rows, 210.))
                    .into_any_element()
            }
            Mode::LinkEditor { .. } => div()
                .flex()
                .flex_col()
                .gap(px(7.))
                .px(px(15.))
                .py(px(13.))
                .child(div().text_size(px(13.)).text_color(colors.text_strong).child("Edit link"))
                .child(small("Text", colors.text_soft))
                .child(self.field_box(None, self.field.clone(), window, cx))
                .child(small("Destination", colors.text_soft))
                .child(self.field_box(None, self.field_href.clone(), window, cx))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .pt(px(4.))
                        .child(button("save-link", "Save link", Tone::Primary, &colors).on_click(cx.listener(|this, _, window, cx| this.save_link(window, cx))))
                        .child(button("remove-link", "Remove link", Tone::Plain, &colors).on_click(cx.listener(|this, _, window, cx| this.remove_link(window, cx))))
                        .child(button("cancel-link", "Cancel", Tone::Plain, &colors).on_click(cx.listener(|this, _, window, cx| this.close_palette(window, cx)))),
                )
                .child(small("Enter to save · Tab to switch fields · Esc to cancel", colors.muted).text_size(px(11.)))
                .into_any_element(),
            Mode::Confirm(confirmation) => div()
                .flex()
                .flex_col()
                .gap(px(5.))
                .px(px(15.))
                .py(px(13.))
                .child(div().text_size(px(13.)).text_color(colors.text_strong).child(confirmation.title.clone()))
                .child(small(confirmation.description.clone(), colors.muted))
                .child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .pt(px(8.))
                        .child(
                            button("confirm", confirmation.confirm_label, if confirmation.danger { Tone::Danger } else { Tone::Primary }, &colors)
                                .on_click(cx.listener(|this, _, window, cx| this.settle_confirmation(true, window, cx))),
                        )
                        .child(
                            button("cancel", confirmation.cancel_label, Tone::Plain, &colors)
                                .on_click(cx.listener(|this, _, window, cx| this.settle_confirmation(false, window, cx))),
                        ),
                )
                .child(small("Enter to confirm · Esc to cancel", colors.quiet).text_size(px(10.)).pt(px(4.)))
                .into_any_element(),
            Mode::Status(status) => {
                let kib = |bytes: u64| {
                    if bytes >= 1024 * 1024 { format!("{:.1} MB", bytes as f64 / 1_048_576.) } else { format!("{:.1} KB", bytes as f64 / 1024.) }
                };
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .px(px(15.))
                    .py(px(13.))
                    .text_size(px(13.))
                    .text_color(colors.text_soft)
                    .child(format!(
                        "{} local {}{}",
                        status.active,
                        if status.active == 1 { "session" } else { "sessions" },
                        if status.archived > 0 { format!(" · {} archived", status.archived) } else { String::new() }
                    ))
                    .child(small(status.root.display().to_string(), colors.muted))
                    .child(small(
                        format!(
                            "Notes {} · History {} · {} {} ({})",
                            kib(status.note_bytes),
                            kib(status.history_bytes),
                            status.asset_count,
                            if status.asset_count == 1 { "image" } else { "images" },
                            kib(status.asset_bytes)
                        ),
                        colors.muted,
                    ))
                    .child(small("Atomic file writes · no network access · Enter to show the folder", colors.muted))
                    .into_any_element()
            }
            Mode::Licenses => div()
                .flex()
                .flex_col()
                .child(self.header("Licenses", "Themes and fonts".into()))
                .child(
                    div()
                        .id("licenses-text")
                        .max_h(px(260.))
                        .overflow_y_scroll()
                        .px(px(14.))
                        .pb(px(12.))
                        .font_family(MONO)
                        .text_size(px(10.5))
                        .line_height(px(15.))
                        .text_color(colors.text_dim)
                        .child(format!(
                            "{NOTICES}\n\n# Geist and Geist Mono\n\nCopyright (c) 2023 Vercel, in collaboration with basement.studio.\nLicensed under the SIL Open Font License, Version 1.1. See desktop/assets/fonts/OFL.txt."
                        )),
                )
                .into_any_element(),
        }
    }

    fn footer(&self, text: &str) -> Div {
        div()
            .mt(px(5.))
            .px(px(5.))
            .pt(px(8.))
            .pb(px(2.))
            .border_t_1()
            .border_color(self.colors.surface_hover)
            .text_size(px(10.))
            .text_color(self.colors.quiet)
            .child(text.to_string())
    }

    fn render_palette(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let palette = self.palette.as_ref()?;
        let colors = self.colors;
        let viewport = window.viewport_size();
        let width = px(PALETTE_WIDTH).min(viewport.width - px(48.));
        let height = px(PALETTE_MAX_HEIGHT);
        let left = palette
            .anchor
            .x
            .clamp(px(8.), (viewport.width - width - px(8.)).max(px(8.)));
        let below = palette.anchor_bottom + px(10.);
        let above = palette.anchor.y - height - px(10.);
        let top = if below + height <= viewport.height - px(8.) {
            below
        } else {
            above.max(px(8.))
        };
        let selected = palette.selected;
        self.palette_scroll.scroll_to_item(selected);
        let body = self.render_palette_body(window, cx);
        Some(
            div()
                .id("palette")
                .absolute()
                .left(left)
                .top(top)
                .w(width)
                .max_h(height)
                .overflow_hidden()
                .rounded(px(13.))
                .border_1()
                .border_color(colors.border_subtle)
                .bg(colors.surface)
                .shadow(shadow(&colors, 18., 54.))
                .text_color(colors.text_strong)
                .font_family(SANS)
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(body)
                .into_any_element(),
        )
    }

    fn render_outline(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let colors = self.colors;
        let (items, active) = {
            let editor = self.editor.read(cx);
            let items = outline(editor.text());
            let active = active_outline_index(&items, editor.cursor());
            (items, active)
        };
        let viewport = window.viewport_size();
        let top = (viewport.height * 0.15).clamp(px(24.), px(164.));
        let count = items.len();
        let rows: Vec<AnyElement> = items
            .into_iter()
            .enumerate()
            .map(|(i, item)| {
                let is_active = Some(i) == active;
                let position = item.position;
                div()
                    .id(("outline", i))
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .min_h(px(34.))
                    .py(px(8.))
                    .pr(px(8.))
                    .pl(px(match item.depth {
                        0 => 8.,
                        1 => 22.,
                        _ => 36.,
                    }))
                    .rounded(px(8.))
                    .text_color(if is_active {
                        colors.text_strong
                    } else {
                        colors.text_dim
                    })
                    .when(is_active, |this| this.bg(colors.surface_selected))
                    .hover(|s| s.bg(colors.surface_selected).text_color(colors.text_strong))
                    .cursor_pointer()
                    .child(div().flex_none().mt(px(6.)).size(px(4.)).rounded_full().bg(
                        if is_active {
                            colors.primary
                        } else {
                            colors.border_strong
                        },
                    ))
                    .child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .whitespace_nowrap()
                            .text_size(px(12.))
                            .line_height(px(17.))
                            .child(item.title),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.editor
                            .update(cx, |editor, cx| editor.reveal_offset(position, cx));
                        window.focus(&this.editor.read(cx).focus_handle.clone(), cx);
                    }))
                    .into_any_element()
            })
            .collect();
        div()
            .id("outline-panel")
            .absolute()
            .top(top)
            .right(px(24.))
            .w(px(208.))
            .max_h(px(520.).min(viewport.height - top - px(24.)))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(13.))
            .border_1()
            .border_color(colors.border_subtle)
            .bg(colors.surface)
            .shadow(shadow(&colors, 20., 54.))
            .font_family(SANS)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_start()
                    .gap(px(14.))
                    .pt(px(13.))
                    .pr(px(12.))
                    .pb(px(11.))
                    .pl(px(14.))
                    .border_b_1()
                    .border_color(colors.surface_hover)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(colors.text_soft)
                                    .child("Outline"),
                            )
                            .child(
                                div()
                                    .mt(px(4.))
                                    .text_size(px(11.))
                                    .text_color(colors.muted)
                                    .child(if count == 0 {
                                        "No sections yet".to_string()
                                    } else {
                                        format!(
                                            "{count} {}",
                                            if count == 1 { "section" } else { "sections" }
                                        )
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .id("outline-close")
                            .size(px(25.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(7.))
                            .text_size(px(19.))
                            .text_color(colors.muted)
                            .hover(|s| s.bg(colors.surface_hover).text_color(colors.heading))
                            .cursor_pointer()
                            .child("×")
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_outline(cx))),
                    ),
            )
            .child(if rows.is_empty() {
                div()
                    .px(px(14.))
                    .pt(px(15.))
                    .pb(px(17.))
                    .text_size(px(12.))
                    .text_color(colors.muted)
                    .child("Type a heading with # to build your outline.")
                    .into_any_element()
            } else {
                div()
                    .id("outline-list")
                    .p(px(5.))
                    .overflow_y_scroll()
                    .flex()
                    .flex_col()
                    .children(rows)
                    .into_any_element()
            })
            .into_any_element()
    }

    fn render_notice(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let notice = self.notice.as_ref()?;
        let colors = self.colors;
        let border = match notice.kind {
            NoticeKind::Info => colors.border_strong,
            NoticeKind::Warning => gpui::rgb(0x9a7a49).into(),
            NoticeKind::Error => gpui::rgb(0x8a5050).into(),
        };
        Some(
            div()
                .id("notice")
                .absolute()
                .right(px(24.))
                .bottom(px(24.))
                .max_w(px(420.))
                .flex()
                .items_start()
                .gap(px(10.))
                .px(px(12.))
                .py(px(10.))
                .rounded(px(9.))
                .border_1()
                .border_color(border)
                .bg(colors.surface_control)
                .text_size(px(13.))
                .line_height(px(18.))
                .text_color(colors.text_soft)
                .font_family(SANS)
                .child(div().flex_1().min_w_0().child(notice.message.clone()))
                .child(
                    button("dismiss", "Dismiss", Tone::Plain, &colors)
                        .min_h(px(0.))
                        .px(px(7.))
                        .py(px(3.))
                        .text_size(px(10.))
                        .on_click(cx.listener(|this, _, _, cx| this.dismiss_notice(cx))),
                )
                .into_any_element(),
        )
    }
}

impl Render for LabApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let colors = self.colors;
        let outline = self.outline_open.then(|| self.render_outline(window, cx));
        let palette = self.render_palette(window, cx);
        let notice = self.render_notice(cx);
        div()
            .id("lab")
            .key_context("LabApp")
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(|this, _: &PaletteUp, w, cx| this.palette_up(w, cx)))
            .on_action(cx.listener(|this, _: &PaletteDown, w, cx| this.palette_down(w, cx)))
            .on_action(cx.listener(|this, _: &PaletteConfirm, w, cx| this.confirm_selected(w, cx)))
            .on_action(cx.listener(|this, _: &PaletteClose, w, cx| this.palette_close(w, cx)))
            .on_action(
                cx.listener(|this, _: &PaletteNextField, w, cx| this.palette_next_field(w, cx)),
            )
            .on_action(
                cx.listener(|this, _: &OpenSessions, w, cx| this.shortcut("sessions", w, cx)),
            )
            .on_action(cx.listener(|this, _: &OpenSearch, w, cx| this.shortcut("search", w, cx)))
            .on_action(
                cx.listener(|this, _: &ToggleOutline, w, cx| this.shortcut("outline", w, cx)),
            )
            .on_action(cx.listener(|this, _: &OpenStats, w, cx| this.shortcut("stats", w, cx)))
            .on_action(cx.listener(|this, _: &OpenHistory, w, cx| this.shortcut("history", w, cx)))
            .on_action(
                cx.listener(|this, _: &OpenLanguage, w, cx| this.shortcut("language", w, cx)),
            )
            .on_action(cx.listener(|this, _: &EditLink, w, cx| this.shortcut("edit-link", w, cx)))
            .on_action(cx.listener(|this, _: &NewSession, w, cx| this.shortcut("new", w, cx)))
            .on_action(cx.listener(|this, _: &InsertMath, w, cx| this.shortcut("math", w, cx)))
            .on_action(cx.listener(|this, _: &ExportNote, w, cx| this.shortcut("export", w, cx)))
            .on_action(
                cx.listener(|this, _: &OpenShortcuts, w, cx| this.shortcut("shortcuts", w, cx)),
            )
            .on_action(cx.listener(|this, _: &Quit, _, cx| {
                if this.ready_to_close(cx) {
                    cx.quit();
                }
            }))
            // A click outside an open panel dismisses it. The slash palette
            // closes on its own once the caret leaves the `/query`.
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| {
                    if this
                        .palette
                        .as_ref()
                        .is_some_and(|p| !matches!(p.mode, Mode::Commands { .. }))
                    {
                        this.close_palette(window, cx);
                    }
                }),
            )
            .relative()
            .size_full()
            .bg(colors.paper)
            .text_color(colors.ink)
            .font_family(SANS)
            .child(self.editor.clone())
            .children(outline)
            .children(palette)
            .children(notice)
    }
}
