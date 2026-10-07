//! Rendering for the editor: typography, block containers, and images.

use std::ops::Range;

use gpui::{
    AnyElement, Context, ElementInputHandler, Entity, Font, FontStyle, FontWeight, Hsla,
    InteractiveElement as _, IntoElement, KeyContext, MouseButton, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, StrikethroughStyle, Styled as _, TextRun,
    UnderlineStyle, Window, canvas, div, font, img, prelude::FluentBuilder as _, px,
};

use super::element::LineElement;
use super::markdown::{CalloutKind, Group, InlineStyle, LineInfo, LineKind, inline_spans};
use super::{Editor, EditorMode};
use crate::markdown_info::strip_inline;
use crate::text_ops;
use crate::theme::Colors;

pub const SANS: &str = "Geist";
pub const MONO: &str = "Geist Mono";

pub const BODY_SIZE: f32 = 18.;
pub const BODY_LINE: f32 = 1.62;
const BLANK_HEIGHT: f32 = BODY_SIZE * 0.46;
const COLUMN_WIDTH: f32 = 720.;

pub fn sans(weight: FontWeight, italic: bool) -> Font {
    Font {
        weight,
        style: if italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        },
        ..font(SANS)
    }
}

pub fn mono() -> Font {
    font(MONO)
}

type RunPatch = Box<dyn Fn(&mut TextRun)>;

/// Builds text runs from a base style plus overlapping range overrides.
struct Runs {
    len: usize,
    base: TextRun,
    overrides: Vec<(Range<usize>, RunPatch)>,
}

impl Runs {
    fn new(len: usize, font: Font, color: Hsla) -> Self {
        Self {
            len,
            base: TextRun {
                len: 0,
                font,
                color,
                background_color: None,
                underline: None,
                strikethrough: None,
            },
            overrides: Vec::new(),
        }
    }

    fn add(&mut self, range: Range<usize>, patch: impl Fn(&mut TextRun) + 'static) {
        let range = range.start.min(self.len)..range.end.min(self.len);
        if !range.is_empty() {
            self.overrides.push((range, Box::new(patch)));
        }
    }

    fn build(self) -> Vec<TextRun> {
        if self.len == 0 {
            return Vec::new();
        }
        let mut cuts = vec![0, self.len];
        for (range, _) in &self.overrides {
            cuts.push(range.start);
            cuts.push(range.end);
        }
        cuts.sort_unstable();
        cuts.dedup();
        cuts.windows(2)
            .map(|pair| {
                let mut run = self.base.clone();
                for (range, patch) in &self.overrides {
                    if range.start <= pair[0] && range.end >= pair[1] {
                        patch(&mut run);
                    }
                }
                run.len = pair[1] - pair[0];
                run
            })
            .collect()
    }
}

struct LineLook {
    font: Font,
    size: f32,
    line_height: f32,
    color: Hsla,
    margin_top: f32,
    margin_bottom: f32,
    hang: usize,
    marker: Option<Range<usize>>,
    inline: bool,
    rule: bool,
}

fn look(
    kind: &LineKind,
    group: Group,
    colors: &Colors,
    first: bool,
    previous_blank: bool,
) -> LineLook {
    let body = LineLook {
        font: sans(FontWeight::NORMAL, false),
        size: BODY_SIZE,
        line_height: BODY_SIZE * BODY_LINE,
        color: colors.ink,
        margin_top: 0.,
        margin_bottom: 0.,
        hang: 0,
        marker: None,
        inline: true,
        rule: false,
    };
    let small_mono = |color| LineLook {
        font: mono(),
        size: 11.5,
        line_height: 20.,
        color,
        inline: false,
        ..body_like(colors)
    };
    let mut look = match kind {
        LineKind::Blank => LineLook {
            line_height: BLANK_HEIGHT,
            inline: false,
            ..body
        },
        LineKind::Paragraph => body,
        LineKind::Heading(level, marker) => {
            let (size, line_height, top, bottom) = match level {
                1 => (50., 1.06, 1.7, 0.46),
                2 => (34., 1.14, 1.6, 0.42),
                3 => (23., 1.22, 1.45, 0.36),
                _ => (20., 1.3, 1.2, 0.3),
            };
            let gap = if previous_blank { BLANK_HEIGHT } else { 0. };
            LineLook {
                font: sans(FontWeight::SEMIBOLD, false),
                size,
                line_height: size * line_height,
                color: colors.heading,
                margin_top: if first {
                    0.
                } else {
                    (size * top - gap).max(0.)
                },
                margin_bottom: size * bottom,
                hang: *marker,
                marker: Some(0..*marker),
                ..body
            }
        }
        LineKind::ListItem { marker, .. } => LineLook {
            marker: Some(marker.clone()),
            margin_top: 2.,
            margin_bottom: 2.,
            ..body
        },
        LineKind::Quote { marker, header } => {
            if *header {
                LineLook {
                    font: mono(),
                    size: 10.5,
                    line_height: 22.,
                    color: colors.text_dim,
                    inline: false,
                    ..body
                }
            } else {
                LineLook {
                    color: if matches!(group, Group::Callout(_)) {
                        colors.text_soft
                    } else {
                        colors.text_dim
                    },
                    marker: Some(0..*marker),
                    ..body
                }
            }
        }
        LineKind::FenceOpen
        | LineKind::FenceClose
        | LineKind::MathFence
        | LineKind::TableDelimiter
        | LineKind::DetailsTag => small_mono(colors.quiet),
        LineKind::Code => LineLook {
            font: mono(),
            size: 14.,
            line_height: 14. * 1.65,
            color: colors.text_soft,
            inline: false,
            ..body
        },
        LineKind::Math => LineLook {
            font: mono(),
            size: 16.,
            line_height: 28.,
            color: colors.ink,
            inline: false,
            ..body
        },
        LineKind::TableRow => LineLook {
            size: 15.5,
            line_height: 26.,
            color: colors.text_soft,
            ..body
        },
        LineKind::Rule => LineLook {
            font: mono(),
            size: 13.,
            line_height: 24.,
            color: colors.quiet,
            margin_top: 16.,
            margin_bottom: 16.,
            inline: false,
            rule: true,
            ..body
        },
        LineKind::Image(_) => small_mono(colors.quiet),
        LineKind::DetailsSummary => LineLook {
            font: sans(FontWeight::MEDIUM, false),
            color: colors.text_soft,
            ..body
        },
    };
    if matches!(kind, LineKind::Paragraph | LineKind::ListItem { .. }) && group == Group::Details {
        look.color = colors.text_soft;
    }
    look
}

fn body_like(colors: &Colors) -> LineLook {
    LineLook {
        font: sans(FontWeight::NORMAL, false),
        size: BODY_SIZE,
        line_height: BODY_SIZE * BODY_LINE,
        color: colors.ink,
        margin_top: 0.,
        margin_bottom: 0.,
        hang: 0,
        marker: None,
        inline: true,
        rule: false,
    }
}

fn apply_inline(runs: &mut Runs, spans: Vec<(Range<usize>, InlineStyle)>, colors: &Colors) {
    for (range, style) in spans {
        let colors = *colors;
        runs.add(range, move |run| {
            if style.marker {
                run.color = colors.quiet;
            }
            if style.bold {
                run.font.weight = FontWeight::SEMIBOLD;
            }
            if style.italic {
                run.font.style = FontStyle::Italic;
            }
            if style.code || style.math {
                run.font = mono();
                run.color = colors.text_soft;
                if style.code {
                    run.background_color = Some(colors.surface_control);
                }
            }
            if style.strike {
                run.strikethrough = Some(StrikethroughStyle {
                    thickness: px(1.),
                    color: Some(run.color),
                });
            }
            if style.link {
                run.color = colors.text_strong;
                run.underline = Some(UnderlineStyle {
                    thickness: px(1.),
                    color: Some(colors.border_strong),
                    wavy: false,
                });
            }
        });
    }
}

impl Editor {
    fn key_context(&self) -> KeyContext {
        let mut context = KeyContext::new_with_defaults();
        context.add("Editor");
        if self.mode == EditorMode::SingleLine {
            context.add("single_line");
        }
        if self.palette_open {
            context.add("palette");
        }
        if self.palette_confirms {
            context.add("palette_confirms");
        }
        context
    }

    fn line_element(
        &self,
        entity: &Entity<Self>,
        index: usize,
        info: &LineInfo,
        look: LineLook,
        collapsed: bool,
    ) -> LineElement {
        let text = &self.text[info.range.clone()];
        let colors = self.colors;
        let mut runs = Runs::new(text.len(), look.font.clone(), look.color);
        if look.inline {
            apply_inline(&mut runs, inline_spans(text), &colors);
        }
        if let Some(marker) = look.marker.clone() {
            runs.add(marker, move |run| {
                run.color = colors.quiet;
                run.font.weight = FontWeight::NORMAL;
            });
        }
        if let LineKind::ListItem {
            task: Some(true),
            marker,
        } = &info.kind
        {
            let end = text.len();
            runs.add(marker.end..end, move |run| run.color = colors.muted);
        }
        if let Some(marked) = &self.marked
            && marked.start >= info.range.start
            && marked.end <= info.range.end
        {
            runs.add(
                marked.start - info.range.start..marked.end - info.range.start,
                |run| {
                    run.underline = Some(UnderlineStyle {
                        thickness: px(1.),
                        color: Some(run.color),
                        wavy: false,
                    });
                },
            );
        }
        LineElement {
            editor: entity.clone(),
            index,
            range: info.range.clone(),
            text: SharedString::from(text.to_string()),
            runs: runs.build(),
            font_size: px(look.size),
            line_height: px(look.line_height),
            hang: look.hang,
            collapsed,
            rule: look.rule.then_some(colors.line),
            caret: colors.primary,
            selection: colors.selection,
            margin_top: px(look.margin_top),
            margin_bottom: px(look.margin_bottom),
            wrap: true,
        }
    }

    fn container(group: Group, colors: &Colors) -> gpui::Div {
        let base = div().flex().flex_col().w_full();
        match group {
            Group::None => base,
            Group::Code => base
                .my(px(19.8))
                .px(px(19.8))
                .py(px(16.))
                .bg(colors.surface)
                .border_1()
                .border_color(colors.line)
                .rounded(px(10.)),
            Group::Math => base
                .my(px(16.))
                .px(px(16.))
                .py(px(10.))
                .rounded(px(8.))
                .bg(colors.subtle_highlight),
            Group::Quote => base
                .my(px(18.))
                .pl(px(18.))
                .border_l_2()
                .border_color(colors.border_strong),
            Group::Callout(kind) => {
                let (accent, tint) = match kind {
                    CalloutKind::Note => (colors.border, None),
                    CalloutKind::Tip => (colors.callout_tip, Some(colors.callout_tip)),
                    CalloutKind::Warning => (colors.callout_warning, Some(colors.callout_warning)),
                    CalloutKind::Important => {
                        (colors.callout_important, Some(colors.callout_important))
                    }
                };
                let background = tint.map_or(colors.surface, |tint| tint.opacity(0.1));
                base.my(px(19.))
                    .pl(px(18.))
                    .pr(px(18.))
                    .pt(px(10.))
                    .pb(px(13.))
                    .bg(background)
                    .border_1()
                    .border_color(colors.border)
                    .border_l_4()
                    .rounded(px(9.))
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .top_0()
                            .bottom_0()
                            .w(px(3.))
                            .bg(accent)
                            .rounded_l(px(9.)),
                    )
                    .relative()
            }
            Group::Table => base
                .my(px(16.))
                .px(px(14.))
                .py(px(8.))
                .rounded(px(8.))
                .border_1()
                .border_color(colors.border)
                .bg(colors.surface_raised),
            Group::Details => base
                .my(px(19.))
                .px(px(15.))
                .py(px(10.))
                .border_1()
                .border_color(colors.border)
                .rounded(px(9.))
                .bg(colors.surface),
        }
    }

    fn render_document(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let entity = cx.entity();
        let infos = self.line_infos();
        self.layout.borrow_mut().reset(infos.len());
        let colors = self.colors;
        let viewport = window.viewport_size();
        let width = px(COLUMN_WIDTH).min(viewport.width - px(48.)).max(px(120.));
        let top = (viewport.height * 0.15).clamp(px(88.), px(164.));
        let bottom = viewport.height * 0.34;
        let selection = self.selection.clone();

        let mut blocks: Vec<AnyElement> = Vec::new();
        let mut index = 0;
        while index < infos.len() {
            let group = infos[index].group;
            let start = index;
            index += 1;
            if group != Group::None {
                while index < infos.len() && infos[index].group == group {
                    // A callout header starts a new callout.
                    if matches!(infos[index].kind, LineKind::Quote { header: true, .. }) {
                        break;
                    }
                    index += 1;
                }
            }
            let mut children: Vec<AnyElement> = Vec::new();
            // A table the caret is not in reads as a grid, like the web editor.
            let table_range = infos[start].range.start..infos[index - 1].range.end;
            let in_table = selection.start <= table_range.end && selection.end >= table_range.start;
            if group == Group::Table && !in_table {
                for line in start..index {
                    let info = &infos[line];
                    let look = look(&info.kind, info.group, &colors, false, false);
                    children.push(
                        self.line_element(&entity, line, info, look, true)
                            .into_any_element(),
                    );
                }
                children.push(self.table_grid(&infos[start..index], start, cx));
                blocks.extend(children);
                continue;
            }
            for line in start..index {
                let info = &infos[line];
                let previous_blank = line > 0 && infos[line - 1].kind == LineKind::Blank;
                let first = line == 0 || infos[..line].iter().all(|i| i.kind == LineKind::Blank);
                let look = look(&info.kind, info.group, &colors, first, previous_blank);
                let touched =
                    selection.start <= info.range.end && selection.end >= info.range.start;
                let image = match &info.kind {
                    LineKind::Image(image) => self
                        .resolve_image(&image.src)
                        .map(|path| (image.clone(), path)),
                    _ => None,
                };
                let collapsed = image.is_some() && !touched;
                children.push(
                    self.line_element(&entity, line, info, look, collapsed)
                        .into_any_element(),
                );
                if let Some((image, path)) = image {
                    let range_start = info.range.start;
                    let picture = img(path)
                        .max_w_full()
                        .rounded(px(8.))
                        .when_some(image.width, |this, width| this.w(px(width as f32)))
                        .id(("image", line))
                        .cursor_pointer()
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(move |this, _, window, cx| {
                                window.focus(&this.focus_handle, cx);
                                this.set_cursor(range_start, cx);
                                cx.stop_propagation();
                            }),
                        );
                    children.push(
                        div()
                            .flex()
                            .w_full()
                            .my(px(8.))
                            .when(image.centered, |this| this.justify_center())
                            .child(picture)
                            .into_any_element(),
                    );
                }
            }
            if group == Group::None {
                blocks.extend(children);
            } else {
                blocks.push(
                    Self::container(group, &colors)
                        .children(children)
                        .into_any_element(),
                );
            }
        }

        let focus = self.focus_handle.clone();
        div()
            .relative()
            .size_full()
            .child(
                div()
                    .id("lab-editor-scroll")
                    .key_context(self.key_context())
                    .track_focus(&self.focus_handle)
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .cursor_text()
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .map(|this| self.register_actions(this, cx))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .w(width)
                            .mx_auto()
                            .pt(top)
                            .pb(bottom)
                            .children(blocks),
                    ),
            )
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, cx| {
                        window.handle_input(&focus, ElementInputHandler::new(bounds, entity), cx);
                    },
                )
                .absolute()
                .size_full(),
            )
            .into_any_element()
    }

    fn render_single_line(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let entity = cx.entity();
        self.layout.borrow_mut().reset(1);
        let colors = self.colors;
        let info = LineInfo {
            range: 0..self.text.len(),
            kind: LineKind::Paragraph,
            group: Group::None,
        };
        let look = LineLook {
            font: sans(FontWeight::NORMAL, false),
            size: 13.,
            line_height: 18.,
            color: colors.text_strong,
            inline: false,
            ..body_like(&colors)
        };
        let mut line = self.line_element(&entity, 0, &info, look, false);
        line.wrap = false;
        let focus = self.focus_handle.clone();
        div()
            .id("lab-field")
            .key_context(self.key_context())
            .track_focus(&self.focus_handle)
            .relative()
            .w_full()
            .h(px(18.))
            .overflow_hidden()
            .cursor_text()
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .map(|this| self.register_actions(this, cx))
            .child(line)
            .when(
                self.text.is_empty() && !self.placeholder.is_empty(),
                |this| {
                    this.child(
                        div()
                            .absolute()
                            .top_0()
                            .left_0()
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .font_family(SANS)
                            .text_color(colors.quiet)
                            .child(self.placeholder.clone()),
                    )
                },
            )
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, cx| {
                        window.handle_input(&focus, ElementInputHandler::new(bounds, entity), cx);
                    },
                )
                .absolute()
                .size_full(),
            )
            .into_any_element()
    }

    fn table_grid(
        &self,
        lines: &[LineInfo],
        first_line: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let colors = self.colors;
        let mut rows: Vec<Vec<(String, usize)>> = Vec::new();
        for info in lines {
            if info.kind == LineKind::TableDelimiter {
                continue;
            }
            let text = &self.text[info.range.clone()];
            let cells = text_ops::split_cells(text);
            let starts = text_ops::cell_starts(text);
            rows.push(
                cells
                    .into_iter()
                    .enumerate()
                    .map(|(i, cell)| {
                        (
                            strip_inline(&cell),
                            info.range.start + starts.get(i).copied().unwrap_or(0),
                        )
                    })
                    .collect(),
            );
        }
        let width = rows.iter().map(Vec::len).max().unwrap_or(1);
        let grid = div()
            .my(px(16.))
            .w_full()
            .flex()
            .flex_col()
            .rounded(px(8.))
            .border_1()
            .border_color(colors.border)
            .overflow_hidden()
            .children(rows.into_iter().enumerate().map(|(r, cells)| {
                div()
                    .flex()
                    .w_full()
                    .when(r > 0, |row| row.border_t_1().border_color(colors.border))
                    .children((0..width).map(|c| {
                        let (text, offset) = cells.get(c).cloned().unwrap_or_else(|| {
                            (String::new(), cells.last().map_or(0, |cell| cell.1))
                        });
                        div()
                            .id(("cell", (first_line + r) * 256 + c))
                            .flex_1()
                            .min_w_0()
                            .px(px(10.8))
                            .py(px(8.6))
                            .when(c > 0, |cell| cell.border_l_1().border_color(colors.border))
                            .when(r == 0, |cell| {
                                cell.bg(colors.surface_raised)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(colors.heading)
                            })
                            .when(r > 0, |cell| cell.text_color(colors.text_soft))
                            .font_family(SANS)
                            .text_size(px(15.5))
                            .line_height(px(22.))
                            .cursor_text()
                            .child(text)
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(move |this, _, window, cx| {
                                    window.focus(&this.focus_handle, cx);
                                    this.set_cursor(offset, cx);
                                    cx.stop_propagation();
                                }),
                            )
                    }))
            }));
        grid.into_any_element()
    }

    fn resolve_image(&self, src: &str) -> Option<std::path::PathBuf> {
        let id = src.strip_prefix("lab-asset://")?;
        self.asset_resolver.as_ref()?(id)
    }

    fn register_actions(
        &self,
        element: gpui::Stateful<gpui::Div>,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        element
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::page_up))
            .on_action(cx.listener(Self::page_down))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::line_start))
            .on_action(cx.listener(Self::line_end))
            .on_action(cx.listener(Self::select_line_start))
            .on_action(cx.listener(Self::select_line_end))
            .on_action(cx.listener(Self::doc_start))
            .on_action(cx.listener(Self::doc_end))
            .on_action(cx.listener(Self::select_doc_start))
            .on_action(cx.listener(Self::select_doc_end))
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_left))
            .on_action(cx.listener(Self::delete_word_right))
            .on_action(cx.listener(Self::delete_to_line_start))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::newline_plain))
            .on_action(cx.listener(Self::indent))
            .on_action(cx.listener(Self::outdent))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::undo_action))
            .on_action(cx.listener(Self::redo_action))
            .on_action(cx.listener(Self::toggle_bold))
            .on_action(cx.listener(Self::toggle_italic))
            .on_action(cx.listener(Self::show_character_palette))
    }
}

impl Render for Editor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        match self.mode {
            EditorMode::Document => self.render_document(window, cx),
            EditorMode::SingleLine => self.render_single_line(window, cx),
        }
    }
}
