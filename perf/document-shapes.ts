const PIXEL_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function longParagraphDocument() {
  const sentence = "A long paragraph keeps all text in one editor node and exercises mapping, layout, and selection work. ";
  return [
    "# Long paragraph",
    "",
    sentence.repeat(Math.ceil(240_000 / sentence.length)),
    "",
    "marker-long-paragraph",
  ].join("\n");
}

function nestedListDocument() {
  return [
    "# Nested lists",
    "",
    ...Array.from({ length: 700 }, (_, group) => [
      `- group ${group}`,
      ...Array.from(
        { length: 7 },
        (_, depth) => `${"  ".repeat(depth + 1)}- depth ${depth + 1} item for group ${group}`,
      ),
    ].join("\n")),
    "",
    "marker-nested-lists",
  ].join("\n");
}

function tableHeavyDocument() {
  return [
    "# Table heavy",
    "",
    ...Array.from({ length: 180 }, (_, table) => [
      `## Table ${table}`,
      "",
      "| Item | State | Owner | Count | Detail |",
      "| --- | --- | --- | ---: | --- |",
      ...Array.from(
        { length: 16 },
        (_, row) => `| item-${table}-${row} | active | owner-${row % 7} | ${table * 16 + row} | stable table content |`,
      ),
      "",
    ].join("\n")),
    "marker-table-heavy",
  ].join("\n");
}

function renderHeavyDocument() {
  return [
    "# Render heavy",
    "",
    ...Array.from({ length: 300 }, (_, index) => [
      `## Formula and image ${index}`,
      "",
      `Inline equation $$x_${index}^2 + y_${index}^2 = z_${index}^2$$ with supporting text.`,
      "",
      "$$",
      `\\sum_{k=0}^{${index % 20 + 5}} k^2 = \\frac{n(n+1)(2n+1)}{6}`,
      "$$",
      "",
      `![pixel ${index}](${PIXEL_IMAGE})`,
      "",
    ].join("\n")),
    "marker-render-heavy",
  ].join("\n");
}

export const ALTERNATE_DOCUMENT_SHAPES = [
  {
    id: "long-paragraph",
    label: "one 240 KB paragraph",
    markdown: longParagraphDocument(),
    headingCount: 1,
    marker: "marker-long-paragraph",
    budgetMs: 4_000,
  },
  {
    id: "nested-lists",
    label: "700 deeply nested list groups",
    markdown: nestedListDocument(),
    headingCount: 1,
    marker: "marker-nested-lists",
    budgetMs: 4_000,
  },
  {
    id: "table-heavy",
    label: "180 tables with 2,880 body rows",
    markdown: tableHeavyDocument(),
    headingCount: 1,
    marker: "marker-table-heavy",
    budgetMs: 6_000,
  },
  {
    id: "render-heavy",
    label: "300 math and image sections",
    markdown: renderHeavyDocument(),
    headingCount: 1,
    marker: "marker-render-heavy",
    budgetMs: 8_000,
  },
] as const;
