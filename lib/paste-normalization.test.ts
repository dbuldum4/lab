import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyClipboardPaste,
  classifyStandaloneLatex,
  htmlHasSemanticStructure,
  htmlIsPlainMarkdownWrapper,
  looksLikeMarkdown,
  markdownScore,
  normalizeMarkdownLatex,
  type PasteIntent,
} from "./paste-normalization.ts";

function kind(intent: PasteIntent) {
  return intent.kind;
}

test("looksLikeMarkdown detects strong block constructs", () => {
  const cases: Array<[string, boolean]> = [
    ["# Heading", true],
    ["## Subheading\n\nwith a paragraph", true],
    ["> a blockquote", true],
    ["```js\nconst x = 1;\n```", true],
    ["- [x] done\n- [ ] todo", true],
    ["- one\n- two\n- three", true],
    ["1. first\n2. second", true],
    ["| a | b |\n|---|---|\n| 1 | 2 |", true],
    ["---", true],
    ["[link](https://example.com) and **bold** and `code`", true],
    ["paragraph one\n\nparagraph two", false],
    ["plain text only", false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(looksLikeMarkdown(text), expected, JSON.stringify(text));
  }
});

test("ambiguous standalone tokens stay plain text", () => {
  const cases = [
    "#hashtag",
    "-3",
    "1.2",
    "$5",
    "$20.00",
    "The price is $5",
    "cost is $x",
    "_identifier_",
    "*",
    "-",
    ">",
    "2 * 3 = 6",
    "v1.2.3",
    "file_name",
    "snake_case_value",
    "https://example.com/path",
    "Привет мир",
    "héllo wörld",
    "C:\\Users\\demo",
  ];
  for (const text of cases) {
    assert.equal(looksLikeMarkdown(text), false, JSON.stringify(text));
    assert.equal(kind(classifyClipboardPaste({ plainText: text, html: "" })), "plain-text", JSON.stringify(text));
  }
});

test("a single weak signal does not trigger Markdown", () => {
  const cases = ["**bold**", "[label](https://example.com)", "`inline code`", "~~struck~~"];
  for (const text of cases) {
    assert.equal(looksLikeMarkdown(text), false, JSON.stringify(text));
  }
});

test("markdownScore gives block constructs more weight than inline ones", () => {
  assert.ok(markdownScore("# Heading") > markdownScore("[link](https://example.com)"));
  assert.equal(markdownScore(""), 0);
  assert.equal(markdownScore("   "), 0);
  assert.equal(markdownScore("# Heading"), 3);
});

test("classifyClipboardPaste maps strong Markdown to the markdown intent", () => {
  const intent = classifyClipboardPaste({ plainText: "# Title\n\nSome text", html: "" });
  assert.equal(intent.kind, "markdown");
  if (intent.kind === "markdown") assert.equal(intent.markdown, "# Title\n\nSome text");
});

test("mixed line endings are normalized", () => {
  const intent = classifyClipboardPaste({ plainText: "# Heading\r\n\r\n> quote\r\n", html: "" });
  assert.equal(intent.kind, "markdown");
  if (intent.kind === "markdown") assert.equal(intent.markdown, "# Heading\n\n> quote\n");
  const plain = classifyClipboardPaste({ plainText: "a\r\nb\r\n", html: "" });
  assert.deepEqual(plain, { kind: "plain-text", text: "a\nb\n" });
});

test("rich HTML wins over Markdown-looking plain text", () => {
  const html = "<h1>Rich Title</h1><p>Some <strong>bold</strong> text</p>";
  const intent = classifyClipboardPaste({
    plainText: "# Rich Title\n\nSome **bold** text",
    html,
  });
  assert.equal(kind(intent), "native");
});

test("meaningful HTML structure is detected", () => {
  assert.equal(htmlHasSemanticStructure("<h1>Title</h1>"), true);
  assert.equal(htmlHasSemanticStructure("<ul><li>one</li></ul>"), true);
  assert.equal(htmlHasSemanticStructure('<a href="https://example.com">link</a>'), true);
  assert.equal(htmlHasSemanticStructure("<p>text</p>"), true);
  assert.equal(htmlHasSemanticStructure("<blockquote>q</blockquote>"), true);
  assert.equal(htmlHasSemanticStructure("<pre>code</pre>"), true);
  assert.equal(htmlHasSemanticStructure("<div>text</div>"), false);
  assert.equal(htmlHasSemanticStructure("<span>text</span>"), false);
  assert.equal(htmlHasSemanticStructure(""), false);
});

test("Markdown wrapped in structureless HTML is detected as a wrapper", () => {
  const cases: Array<[string, string, boolean]> = [
    ["<pre># Heading\n\nparagraph</pre>", "# Heading\n\nparagraph", true],
    ["<div># Heading</div>", "# Heading", true],
    ["<div># Heading &#128512;</div>", "# Heading 😀", true],
    ["<div># Heading &#1114112;</div>", "# Heading &#1114112;", true],
    ["<div># Heading &#x110000;</div>", "# Heading &#x110000;", true],
    ["<div># Heading &#99999999;</div>", "# Heading &#99999999;", true],
    ["<span>- one\n- two</span>", "- one\n- two", true],
    ["<p># Heading</p>", "# Heading", true],
    ["<div><span># Heading</span></div>", "# Heading", true],
    ["<pre><code># Heading\n\nparagraph</code></pre>", "# Heading\n\nparagraph", true],
    ["<pre>console.log(1)</pre>", "console.log(1)", false],
    ["<code>npm install</code>", "npm install", false],
    ["<h1># Heading</h1>", "# Heading", false],
    ["<p><strong>hello</strong></p>", "hello", false],
    ['<a href="https://example.com">label</a>', "label", false],
    ["<div>plain text</div>", "plain text", false],
    ["<div># Heading</div>", "different text", false],
  ];
  for (const [html, plainText, expected] of cases) {
    assert.equal(htmlIsPlainMarkdownWrapper(html, plainText), expected, JSON.stringify(html));
  }
});

test("wrapped Markdown is parsed instead of inserted natively", () => {
  const intent = classifyClipboardPaste({
    plainText: "# Wrapped\n\nparagraph",
    html: "<pre># Wrapped\n\nparagraph</pre>",
  });
  assert.equal(kind(intent), "markdown");
});

test("empty anchors do not create visible text via the HTML path", () => {
  assert.equal(kind(classifyClipboardPaste({ plainText: "", html: '<a id="section-name"></a>' })), "native");
  assert.equal(htmlHasSemanticStructure('<a id="section-name"></a>'), true);
});

test("normalizeMarkdownLatex converts inline delimiters", () => {
  assert.equal(
    normalizeMarkdownLatex("Inline \\(a^2 + b^2\\) math"),
    "Inline $$a^2 + b^2$$ math",
  );
});

test("normalizeMarkdownLatex converts block delimiters", () => {
  assert.equal(
    normalizeMarkdownLatex("\\[\n\\int_0^1 x\\,dx\n\\]"),
    "$$\n\\int_0^1 x\\,dx\n$$",
  );
  assert.equal(normalizeMarkdownLatex("\\[x^2\\]"), "$$\nx^2\n$$");
});

test("normalizeMarkdownLatex keeps existing $$ syntax", () => {
  assert.equal(normalizeMarkdownLatex("Inline $$x^2$$ stays"), "Inline $$x^2$$ stays");
  assert.equal(
    normalizeMarkdownLatex("$$\n\\int_0^1 x\\,dx\n$$"),
    "$$\n\\int_0^1 x\\,dx\n$$",
  );
});

test("normalizeMarkdownLatex converts conservative single-dollar math", () => {
  const cases: Array<[string, string]> = [
    ["$x^2$", "$$x^2$$"],
    ["$\\frac{1}{2}$", "$$\\frac{1}{2}$$"],
    ["$2+3=5$", "$$2+3=5$$"],
    ["$x_1$", "$$x_1$$"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeMarkdownLatex(input), expected, JSON.stringify(input));
  }
});

test("normalizeMarkdownLatex leaves currency and prose alone", () => {
  const cases = ["$5", "$20.00", "The price is $5", "cost is $x", "It costs $5 and $20"];
  for (const text of cases) {
    assert.equal(normalizeMarkdownLatex(text), text, JSON.stringify(text));
  }
});

test("normalizeMarkdownLatex protects code spans and code fences", () => {
  assert.equal(
    normalizeMarkdownLatex("Use `\\(not\\)` and `$x^2$` inline"),
    "Use `\\(not\\)` and `$x^2$` inline",
  );
  assert.equal(
    normalizeMarkdownLatex("```\n\\(literal\\)\n$5\n$$\n```"),
    "```\n\\(literal\\)\n$5\n$$\n```",
  );
  assert.equal(
    normalizeMarkdownLatex("Before\n\n    \\(indented\\)\n\nAfter"),
    "Before\n\n    \\(indented\\)\n\nAfter",
  );
});

test("classifyStandaloneLatex recognizes strong expressions", () => {
  const cases: Array<[string, PasteIntent]> = [
    ["\\frac{a}{b}", { kind: "inline-math", latex: "\\frac{a}{b}" }],
    ["x^2", { kind: "inline-math", latex: "x^2" }],
    ["\\sum_{i=0}^{n} x_i", { kind: "inline-math", latex: "\\sum_{i=0}^{n} x_i" }],
    ["\\sqrt{2}", { kind: "inline-math", latex: "\\sqrt{2}" }],
    ["2^10", { kind: "inline-math", latex: "2^10" }],
    ["$$x^2 + y^2$$", { kind: "inline-math", latex: "x^2 + y^2" }],
    ["$x^2$", { kind: "inline-math", latex: "x^2" }],
    ["\\(a^2\\)", { kind: "inline-math", latex: "a^2" }],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(classifyStandaloneLatex(text), expected, JSON.stringify(text));
  }
});

test("classifyStandaloneLatex uses block math for display content", () => {
  const cases: Array<[string, string]> = [
    ["\\begin{equation}\n\\int_0^1 x\\,dx\n\\end{equation}", "\\begin{equation}\n\\int_0^1 x\\,dx\n\\end{equation}"],
    ["\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}", "\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}"],
    ["\\[\n\\int_0^1 x\\,dx\n\\]", "\\int_0^1 x\\,dx"],
    ["$$\n\\int_0^1 x\\,dx\n$$", "\\int_0^1 x\\,dx"],
    ["x^2\ny^2", "x^2\ny^2"],
  ];
  for (const [text, latex] of cases) {
    assert.deepEqual(classifyStandaloneLatex(text), { kind: "block-math", latex }, JSON.stringify(text));
  }
});

test("classifyStandaloneLatex rejects prose and false positives", () => {
  const cases = [
    "file_name",
    "file_name.txt",
    "x_1.txt",
    "_identifier_",
    "C:\\Users\\demo",
    "Line breaks use \\n in most languages",
    "\\LaTeX is a typesetting system",
    "The area is x^2 meters",
    "Use \\frac{a}{b} for fractions",
    "The price is $5",
    "hello world",
    "$5",
    "\\notacommand",
    "\\qwerty",
    "v1.2.3",
    "",
  ];
  for (const text of cases) {
    assert.equal(classifyStandaloneLatex(text), null, JSON.stringify(text));
  }
});

test("classification of a full payload never turns ordinary prose into math", () => {
  for (const text of ["The price is $5", "#hashtag", "-3", "1.2", "file_name", "hello world"]) {
    assert.equal(kind(classifyClipboardPaste({ plainText: text, html: "" })), "plain-text", JSON.stringify(text));
  }
});

test("empty payloads are handled deterministically", () => {
  assert.equal(kind(classifyClipboardPaste({ plainText: "", html: "" })), "plain-text");
  assert.equal(classifyStandaloneLatex(""), null);
  assert.equal(looksLikeMarkdown(""), false);
  assert.equal(htmlIsPlainMarkdownWrapper("", ""), false);
});
