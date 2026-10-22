//! The element that lays out and paints one source line, and the per-frame
//! table of line layouts used for hit testing, caret placement, and IME.

use std::cell::RefCell;
use std::ops::Range;
use std::rc::Rc;

use gpui::{
    App, Bounds, Element, ElementId, Entity, GlobalElementId, Hsla, InspectorElementId,
    IntoElement, LayoutId, Pixels, Point, SharedString, Style, TextAlign, TextRun, Window,
    WrappedLine, fill, point, px, relative, size,
};

use super::{AutoscrollTarget, Editor};

pub struct LineLayout {
    pub range: Range<usize>,
    /// Where the first glyph row starts, in window coordinates.
    pub origin: Point<Pixels>,
    pub bounds: Bounds<Pixels>,
    pub line_height: Pixels,
    /// `None` for collapsed lines (an image whose source is hidden).
    pub wrapped: Option<Rc<WrappedLine>>,
}

impl LineLayout {
    fn rows(&self) -> usize {
        self.wrapped
            .as_ref()
            .map_or(1, |w| w.wrap_boundaries().len() + 1)
    }

    fn text_bottom(&self) -> Pixels {
        self.origin.y + self.line_height * self.rows() as f32
    }

    fn hit(&self, position: Point<Pixels>) -> usize {
        let Some(wrapped) = &self.wrapped else {
            return self.range.start;
        };
        let mut local = position - self.origin;
        let max_y = self.line_height * self.rows() as f32 - px(1.);
        local.y = local.y.clamp(px(0.), max_y.max(px(0.)));
        local.x = local.x.max(px(0.));
        let index = wrapped
            .closest_index_for_position(local, self.line_height)
            .unwrap_or_else(|index| index);
        (self.range.start + index).min(self.range.end)
    }
}

#[derive(Default)]
pub struct LayoutTable {
    pub lines: Vec<Option<LineLayout>>,
}

impl LayoutTable {
    pub fn reset(&mut self, count: usize) {
        self.lines.clear();
        self.lines.resize_with(count, || None);
    }

    fn visible(&self) -> impl DoubleEndedIterator<Item = &LineLayout> {
        self.lines
            .iter()
            .flatten()
            .filter(|line| line.wrapped.is_some())
    }

    pub fn caret_bounds(&self, offset: usize) -> Option<Bounds<Pixels>> {
        // Prefer the line that holds the offset. Right after an edit the table
        // still describes the previous frame, so fall back to the nearest line
        // that starts before the offset; for typing that is the same line.
        let line = self
            .visible()
            .find(|line| offset >= line.range.start && offset <= line.range.end)
            .or_else(|| self.visible().rev().find(|line| line.range.start <= offset))?;
        let index = (offset - line.range.start).min(line.wrapped.as_ref().map_or(0, |w| w.len()));
        let position = line
            .wrapped
            .as_ref()
            .and_then(|wrapped| wrapped.position_for_index(index, line.line_height))
            .unwrap_or_default();
        Some(Bounds::new(
            line.origin + position,
            size(px(1.5), line.line_height),
        ))
    }

    pub fn index_for_point(&self, position: Point<Pixels>) -> Option<usize> {
        let mut last = None;
        for line in self.visible() {
            if position.y < line.bounds.bottom().max(line.text_bottom()) {
                return Some(line.hit(position));
            }
            last = Some(line);
        }
        last.map(|line| line.hit(point(position.x, line.text_bottom())))
    }

    /// The index on the row above `position`, keeping its x.
    pub fn index_above(&self, position: Point<Pixels>) -> Option<usize> {
        self.visible()
            .rev()
            .find(|line| line.origin.y <= position.y)
            .map(|line| line.hit(position))
    }

    /// The start of a collapsed line (a table drawn as a grid, or an image)
    /// right next to `from`'s line in the direction of `to`, when moving
    /// there would jump over it. Vertical movement enters it instead, which
    /// shows its source.
    pub fn collapsed_between(&self, from: usize, to: usize) -> Option<usize> {
        let current = self.lines.iter().position(|line| {
            line.as_ref().is_some_and(|line| {
                line.wrapped.is_some() && line.range.start <= from && from <= line.range.end
            })
        })?;
        let neighbor = if to > from {
            current + 1
        } else {
            current.checked_sub(1)?
        };
        let line = self.lines.get(neighbor)?.as_ref()?;
        let skipped = if to > from {
            to >= line.range.start
        } else {
            to <= line.range.end
        };
        (line.wrapped.is_none() && skipped).then_some(line.range.start)
    }

    /// The index on the row below `position`, keeping its x.
    pub fn index_below(&self, position: Point<Pixels>) -> Option<usize> {
        self.visible()
            .find(|line| line.text_bottom() > position.y)
            .map(|line| line.hit(point(position.x, position.y.max(line.origin.y))))
    }
}

/// Visual description of one line, built by the editor's render.
pub struct LineElement {
    pub editor: Entity<Editor>,
    pub index: usize,
    pub range: Range<usize>,
    pub text: SharedString,
    pub runs: Vec<TextRun>,
    pub font_size: Pixels,
    pub line_height: Pixels,
    /// Bytes of leading syntax to hang into the left margin.
    pub hang: usize,
    pub collapsed: bool,
    pub rule: Option<Hsla>,
    pub caret: Hsla,
    pub selection: Hsla,
    pub margin_top: Pixels,
    pub margin_bottom: Pixels,
    /// Single-line fields do not wrap; they scroll horizontally instead.
    pub wrap: bool,
}

type Measured = Rc<RefCell<Option<(Option<Pixels>, Rc<WrappedLine>)>>>;

pub struct LinePrepaint {
    layout: Option<Rc<WrappedLine>>,
    origin: Point<Pixels>,
}

impl IntoElement for LineElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

fn shape(
    text: &SharedString,
    runs: &[TextRun],
    font_size: Pixels,
    wrap: Option<Pixels>,
    window: &mut Window,
) -> Option<Rc<WrappedLine>> {
    window
        .text_system()
        .shape_text(text.clone(), font_size, runs, wrap, None)
        .ok()
        .and_then(|mut lines| (!lines.is_empty()).then(|| Rc::new(lines.remove(0))))
}

impl Element for LineElement {
    type RequestLayoutState = Measured;
    type PrepaintState = LinePrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.margin.top = self.margin_top.into();
        style.margin.bottom = self.margin_bottom.into();
        let measured: Measured = Rc::default();
        if self.collapsed {
            style.size.height = px(0.).into();
            return (window.request_layout(style, [], cx), measured);
        }
        let text = self.text.clone();
        let runs = self.runs.clone();
        let font_size = self.font_size;
        let line_height = self.line_height;
        let state = measured.clone();
        let wraps = self.wrap;
        let layout_id =
            window.request_measured_layout(style, move |known, available, window, _cx| {
                let wrap = known.width.or(match available.width {
                    gpui::AvailableSpace::Definite(width) => Some(width),
                    _ => None,
                });
                let wrap = wraps.then_some(wrap).flatten();
                if let Some((cached_wrap, line)) = state.borrow().as_ref()
                    && *cached_wrap == wrap
                {
                    return size(
                        wrap.unwrap_or(line.width()),
                        line_height * (line.wrap_boundaries().len() + 1) as f32,
                    );
                }
                let Some(line) = shape(&text, &runs, font_size, wrap, window) else {
                    return size(wrap.unwrap_or_default(), line_height);
                };
                let rows = line.wrap_boundaries().len() + 1;
                let width = wrap.unwrap_or(line.width());
                *state.borrow_mut() = Some((wrap, line));
                size(width, line_height * rows as f32)
            });
        (layout_id, measured)
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        measured: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let layout = if self.collapsed {
            None
        } else {
            let cached = measured
                .borrow()
                .as_ref()
                .filter(|(wrap, _)| *wrap == self.wrap.then_some(bounds.size.width))
                .map(|(_, line)| line.clone());
            cached.or_else(|| {
                shape(
                    &self.text,
                    &self.runs,
                    self.font_size,
                    self.wrap.then_some(bounds.size.width),
                    window,
                )
            })
        };

        let mut origin = bounds.origin;
        if self.hang > 0
            && let Some(line) = &layout
            && line.wrap_boundaries().is_empty()
            && let Some(position) = line.position_for_index(self.hang, self.line_height)
        {
            origin.x -= position.x;
        }

        let editor = self.editor.read(cx);
        // A field wider than its box keeps the caret in view.
        if !self.wrap
            && let Some(line) = &layout
        {
            let cursor = editor.cursor().clamp(self.range.start, self.range.end) - self.range.start;
            let caret_x = line
                .position_for_index(cursor, self.line_height)
                .map_or(px(0.), |p| p.x);
            let overflow = caret_x + px(2.) - bounds.size.width;
            if overflow > px(0.) {
                origin.x -= overflow;
            }
        }
        let table = editor.layout.clone();
        let autoscroll = editor.autoscroll;
        let cursor = editor.cursor();
        let scroll = editor.scroll.clone();
        {
            let mut table = table.borrow_mut();
            if self.index < table.lines.len() {
                table.lines[self.index] = Some(LineLayout {
                    range: self.range.clone(),
                    origin,
                    bounds,
                    line_height: self.line_height,
                    wrapped: layout.clone(),
                });
            }
        }

        if let Some(target) = autoscroll
            && cursor >= self.range.start
            && cursor <= self.range.end
            && let Some(line) = &layout
        {
            let caret = line
                .position_for_index(cursor - self.range.start, self.line_height)
                .unwrap_or_default();
            let top = origin.y + caret.y;
            let bottom = top + self.line_height;
            let viewport = scroll.bounds();
            if viewport.size.height > px(0.) {
                let mut offset = scroll.offset();
                let margin = px(56.).min(viewport.size.height / 4.);
                match target {
                    AutoscrollTarget::Caret => {
                        if top < viewport.top() + margin {
                            offset.y += viewport.top() + margin - top;
                        } else if bottom > viewport.bottom() - margin {
                            offset.y -= bottom - (viewport.bottom() - margin);
                        }
                    }
                    AutoscrollTarget::Top => offset.y += viewport.top() + px(72.) - top,
                }
                // The scroll container clamps the far end on its next layout.
                offset.y = offset.y.min(px(0.));
                if offset != scroll.offset() {
                    scroll.set_offset(offset);
                    window.refresh();
                }
            }
            self.editor.update(cx, |editor, _| editor.autoscroll = None);
        }

        LinePrepaint { layout, origin }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _measured: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(line) = prepaint.layout.as_ref() else {
            return;
        };
        let origin = prepaint.origin;
        let lh = self.line_height;
        let editor = self.editor.read(cx);
        let selection = editor.selection();
        let cursor = editor.cursor();
        let focused = editor.focus_handle.is_focused(window);
        let blink_on = editor.blink_on;

        // Selection, including a sliver for a selected newline.
        let start = selection.start.max(self.range.start);
        let end = selection.end.min(self.range.end);
        let includes_newline = selection.start <= self.range.end && selection.end > self.range.end;
        if !selection.is_empty() && (start < end || includes_newline) && start <= end {
            let a = line
                .position_for_index(start - self.range.start, lh)
                .unwrap_or_default();
            let b = line
                .position_for_index(end - self.range.start, lh)
                .unwrap_or_default();
            let right = bounds.right() - origin.x;
            let newline_pad = if includes_newline { px(7.) } else { px(0.) };
            let mut rects = Vec::new();
            if a.y == b.y {
                rects.push((a.x, b.x + newline_pad, a.y));
            } else {
                rects.push((a.x, right, a.y));
                let mut y = a.y + lh;
                while y < b.y {
                    rects.push((px(0.), right, y));
                    y += lh;
                }
                rects.push((px(0.), b.x + newline_pad, b.y));
            }
            for (x0, x1, y) in rects {
                if x1 > x0 {
                    window.paint_quad(fill(
                        Bounds::from_corners(origin + point(x0, y), origin + point(x1, y + lh)),
                        self.selection,
                    ));
                }
            }
        }

        let _ = line.paint(origin, lh, TextAlign::Left, None, window, cx);

        if let Some(color) = self.rule {
            let width = line.width();
            let y = origin.y + lh / 2.;
            let x0 = origin.x + width + px(14.);
            if x0 < bounds.right() {
                window.paint_quad(fill(
                    Bounds::from_corners(point(x0, y), point(bounds.right(), y + px(1.))),
                    color,
                ));
            }
        }

        if focused && selection.is_empty() && cursor >= self.range.start && cursor <= self.range.end
        {
            let position = line
                .position_for_index(cursor - self.range.start, lh)
                .unwrap_or_default();
            let color = if blink_on {
                self.caret
            } else {
                self.caret.opacity(0.16)
            };
            // Short lines (paragraph gaps) still get a readable caret.
            let height = lh.max(px(20.));
            let top = origin.y + position.y - (height - lh) / 2.;
            window.paint_quad(fill(
                Bounds::new(point(origin.x + position.x, top), size(px(1.5), height)),
                color,
            ));
        }
    }
}
