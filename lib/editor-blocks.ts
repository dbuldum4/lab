import {
  mergeAttributes,
  Node,
  type JSONContent,
  type MarkdownLexerConfiguration,
  type MarkdownRendererHelpers,
  type MarkdownToken,
} from "@tiptap/core";

/** Callout kinds supported by GitHub's blockquote-alert Markdown syntax. */
export const CALLOUT_TYPES = ["note", "tip", "warning", "important"] as const;

export type CalloutType = (typeof CALLOUT_TYPES)[number];

export type CalloutOptions = {
  HTMLAttributes: Record<string, unknown>;
};

export type CollapsibleSectionOptions = {
  HTMLAttributes: Record<string, unknown>;
};

export type InsertCollapsibleSectionOptions = {
  /** Plain-text summary shown in the native details disclosure control. */
  summary?: string;
  /** Whether the section is initially expanded. */
  open?: boolean;
};

type SourceLine = {
  /** Line text without its line ending (or a trailing CR). */
  text: string;
  /** Offset immediately after the line ending, or source.length at EOF. */
  end: number;
};

type CalloutMarkdownToken = MarkdownToken & {
  type: "callout";
  calloutType: CalloutType;
  tokens: MarkdownToken[];
};

type CollapsibleMarkdownToken = MarkdownToken & {
  type: "collapsibleSection";
  open: boolean;
  summaryTokens: MarkdownToken[];
  tokens: MarkdownToken[];
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      /** Insert an editable callout containing an empty paragraph. */
      insertCallout: (options?: { type?: CalloutType }) => ReturnType;
      /** Change the nearest active callout to one of the supported kinds. */
      setCalloutType: (type: CalloutType) => ReturnType;
      /** Wrap or unwrap the selection in a callout. */
      toggleCallout: (options?: { type?: CalloutType }) => ReturnType;
    };
    collapsibleSection: {
      /** Insert an editable summary and body as a native details section. */
      insertCollapsibleSection: (options?: InsertCollapsibleSectionOptions) => ReturnType;
      /** Set the expanded state of the nearest active details section. */
      setCollapsibleOpen: (open: boolean) => ReturnType;
      /** Toggle the expanded state of the nearest active details section. */
      toggleCollapsibleOpen: () => ReturnType;
    };
  }
}

/**
 * Restrict externally supplied values to the four portable alert kinds.
 * Invalid values intentionally degrade to a note instead of becoming a DOM
 * class or attribute controlled by imported content.
 */
export function normalizeCalloutType(value: unknown): CalloutType {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return (CALLOUT_TYPES as readonly string[]).includes(normalized)
    ? (normalized as CalloutType)
    : "note";
}

function sourceLineAt(source: string, offset: number): SourceLine {
  const newline = source.indexOf("\n", offset);
  const end = newline < 0 ? source.length : newline + 1;
  const lineEnd = newline < 0 ? source.length : newline;
  return {
    text: source.slice(offset, lineEnd).replace(/\r$/, ""),
    end,
  };
}

function firstCalloutOffset(source: string) {
  const match = source.match(/^>[ \t]*\[!(?:NOTE|TIP|WARNING|IMPORTANT)\][ \t]*$/im);
  return match?.index ?? -1;
}

/** Tokenize one strict GitHub-style alert blockquote from the source start. */
function tokenizeCallout(
  source: string,
  lexer: MarkdownLexerConfiguration,
): CalloutMarkdownToken | undefined {
  const openingLine = sourceLineAt(source, 0);
  const opening = openingLine.text.match(
    /^>[ \t]*\[!(NOTE|TIP|WARNING|IMPORTANT)\][ \t]*$/i,
  );
  if (!opening) return undefined;

  let offset = openingLine.end;
  const bodyLines: string[] = [];

  while (offset < source.length) {
    const line = sourceLineAt(source, offset);
    if (!/^>/.test(line.text)) break;

    // Markdown blockquotes discard the marker and at most one following
    // whitespace character. Leaving any further indentation intact is
    // important for nested lists and code blocks.
    bodyLines.push(line.text.replace(/^>[ \t]?/, ""));
    offset = line.end;
  }

  const body = bodyLines.join("\n");
  return {
    type: "callout",
    raw: source.slice(0, offset),
    calloutType: normalizeCalloutType(opening[1]),
    tokens: body.trim() ? lexer.blockTokens(body) : [],
  };
}

function renderQuotedLines(markdown: string) {
  return markdown.split("\n").map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
}

function renderCalloutContent(node: JSONContent, helpers: MarkdownRendererHelpers) {
  const children = node.content ?? [];
  return children.map((child, index) => {
    const rendered = helpers.renderChild?.(child, index) ?? helpers.renderChildren([child]);
    return renderQuotedLines(rendered);
  }).join("\n>\n");
}

/**
 * Editable callout serialized as GitHub's portable alert syntax:
 *
 *     > [!NOTE]
 *     > Alert body
 */
export const Callout = Node.create<CalloutOptions>({
  name: "callout",

  priority: 110,

  group: "block",

  content: "block+",

  defining: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (element) => normalizeCalloutType(element.getAttribute("data-callout-type")),
        renderHTML: (attributes) => ({
          "data-callout-type": normalizeCalloutType(attributes.type),
        }),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'aside[data-type="callout"]' },
      { tag: 'blockquote[data-type="callout"]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const type = normalizeCalloutType(HTMLAttributes["data-callout-type"] ?? HTMLAttributes.type);
    return [
      "aside",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-type": "callout",
        "data-callout-type": type,
        role: "note",
      }),
      0,
    ];
  },

  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: firstCalloutOffset,
    tokenize: (source, _tokens, lexer) => tokenizeCallout(source, lexer),
  },

  parseMarkdown: (token, helpers) => {
    const parsed = helpers.parseChildren(token.tokens ?? []);
    const content = parsed.length > 0 ? parsed : [helpers.createNode("paragraph")];
    return helpers.createNode(
      "callout",
      { type: normalizeCalloutType(token.calloutType) },
      content,
    );
  },

  renderMarkdown: (node, helpers) => {
    const type = normalizeCalloutType(node.attrs?.type).toUpperCase();
    const content = renderCalloutContent(node, helpers);
    return content ? `> [!${type}]\n${content}` : `> [!${type}]`;
  },

  addCommands() {
    return {
      insertCallout:
        (options = {}) =>
        ({ commands }) => commands.insertContent({
          type: this.name,
          attrs: { type: normalizeCalloutType(options.type) },
          content: [{ type: "paragraph" }],
        }),
      setCalloutType:
        (type) =>
        ({ commands }) => commands.updateAttributes(this.name, {
          type: normalizeCalloutType(type),
        }),
      toggleCallout:
        (options = {}) =>
        ({ commands }) => commands.toggleWrap(this.name, {
          type: normalizeCalloutType(options.type),
        }),
    };
  },
});

function parseDetailsOpening(source: string) {
  const match = source.match(/^<details([^>\n]*)>[ \t]*(?:\r?\n|$)/i);
  if (!match) return undefined;

  const attributes = match[1].trim();
  // Accept only the standard boolean `open` attribute. Imported event,
  // style, URL, and arbitrary data attributes never enter the editor schema.
  if (attributes && !/^open(?:\s*=\s*(?:"(?:open)?"|'(?:open)?'|open))?$/i.test(attributes)) {
    return undefined;
  }

  return {
    end: match[0].length,
    open: attributes.length > 0,
  };
}

function firstDetailsOffset(source: string) {
  const match = source.match(/^<details(?:[ \t]|>)/im);
  return match?.index ?? -1;
}

function fenceMarker(line: string) {
  const match = line.match(/^[ ]{0,3}(`{3,}|~{3,})/);
  return match?.[1];
}

function isClosingFence(line: string, marker: string) {
  const character = marker[0];
  return new RegExp(`^[ ]{0,3}${character}{${marker.length},}[ \\t]*$`).test(line);
}

/** Tokenize one safe, native details/summary block from the source start. */
function tokenizeCollapsible(
  source: string,
  lexer: MarkdownLexerConfiguration,
): CollapsibleMarkdownToken | undefined {
  const opening = parseDetailsOpening(source);
  if (!opening) return undefined;

  const afterOpening = source.slice(opening.end);
  const summary = afterOpening.match(/^<summary>([\s\S]*?)<\/summary>[ \t]*(?:\r?\n|$)/i);
  if (!summary) return undefined;

  const summarySource = summary[1].trim();
  const bodyStart = opening.end + summary[0].length;
  let offset = bodyStart;
  let depth = 1;
  let activeFence: string | undefined;

  while (offset < source.length) {
    const line = sourceLineAt(source, offset);

    if (activeFence) {
      if (isClosingFence(line.text, activeFence)) activeFence = undefined;
      offset = line.end;
      continue;
    }

    const marker = fenceMarker(line.text);
    if (marker) {
      activeFence = marker;
      offset = line.end;
      continue;
    }

    // Count nested raw details blocks while looking for this block's close.
    // Attribute validation is applied when each nested block is tokenized;
    // counting generic openings here prevents their close tag from ending the
    // outer section prematurely.
    if (/^<details(?:\s[^>]*)?>[ \t]*$/i.test(line.text)) {
      depth += 1;
    } else if (/^<\/details>[ \t]*$/i.test(line.text)) {
      depth -= 1;
      if (depth === 0) {
        const bodySource = source.slice(bodyStart, offset).replace(/^\s*\n/, "").trimEnd();
        return {
          type: "collapsibleSection",
          raw: source.slice(0, line.end),
          open: opening.open,
          summaryTokens: summarySource ? lexer.inlineTokens(summarySource) : [],
          tokens: bodySource.trim() ? lexer.blockTokens(bodySource) : [],
        };
      }
    }

    offset = line.end;
  }

  return undefined;
}

/** Inline, editable first child of a CollapsibleSection. */
export const CollapsibleSummary = Node.create({
  name: "collapsibleSummary",

  content: "inline*",

  defining: true,

  parseHTML() {
    return [{ tag: "summary" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["summary", mergeAttributes(HTMLAttributes, { "data-collapsible-summary": "" }), 0];
  },

  renderMarkdown: (node, helpers) => helpers.renderChildren(node.content ?? []),
});

/** Editable block-content second child of a CollapsibleSection. */
export const CollapsibleBody = Node.create({
  name: "collapsibleBody",

  content: "block+",

  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-collapsible-body=""]' }, { tag: "div[data-collapsible-body]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-collapsible-body": "" }), 0];
  },

  renderMarkdown: (node, helpers) => helpers.renderChildren(node.content ?? [], "\n\n"),
});

/**
 * Native, keyboard-editable details section. Markdown uses the portable form:
 *
 *     <details open>
 *     <summary>More information</summary>
 *
 *     Body blocks
 *
 *     </details>
 */
export const CollapsibleSection = Node.create<CollapsibleSectionOptions>({
  name: "collapsibleSection",

  priority: 110,

  group: "block",

  content: "collapsibleSummary collapsibleBody",

  defining: true,

  isolating: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (element) => element.hasAttribute("open"),
        renderHTML: (attributes) => (attributes.open ? { open: "" } : {}),
      },
    };
  },

  parseHTML() {
    // Only accept details nodes produced by this extension. Generic details
    // Markdown is handled by the strict tokenizer above, without importing
    // arbitrary HTML attributes.
    return [{ tag: 'details[data-type="collapsible-section"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const open = HTMLAttributes.open === "" || HTMLAttributes.open === true;
    return [
      "details",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        "data-type": "collapsible-section",
        ...(open ? { open: "" } : {}),
      }),
      0,
    ];
  },

  markdownTokenizer: {
    name: "collapsibleSection",
    level: "block",
    start: firstDetailsOffset,
    tokenize: (source, _tokens, lexer) => tokenizeCollapsible(source, lexer),
  },

  parseMarkdown: (token, helpers) => {
    const summaryContent = helpers.parseInline(token.summaryTokens ?? []);
    const parsedBody = helpers.parseChildren(token.tokens ?? []);
    const bodyContent = parsedBody.length > 0 ? parsedBody : [helpers.createNode("paragraph")];

    return helpers.createNode("collapsibleSection", { open: token.open === true }, [
      helpers.createNode("collapsibleSummary", undefined, summaryContent),
      helpers.createNode("collapsibleBody", undefined, bodyContent),
    ]);
  },

  renderMarkdown: (node, helpers) => {
    const children = node.content ?? [];
    const summary = children.find((child) => child.type === "collapsibleSummary");
    const body = children.find((child) => child.type === "collapsibleBody");
    const summaryIndex = summary ? children.indexOf(summary) : 0;
    const bodyIndex = body ? children.indexOf(body) : 1;
    const renderedSummary = summary
      ? (helpers.renderChild?.(summary, summaryIndex) ?? helpers.renderChildren(summary.content ?? []))
      : "";
    const renderedBody = body
      ? (helpers.renderChild?.(body, bodyIndex) ?? helpers.renderChildren(body.content ?? [], "\n\n"))
      : "";
    // A summary is an inline HTML element. Hard breaks are normalized to a
    // space so malformed imported content cannot escape the summary line.
    const singleLineSummary = renderedSummary.replace(/\s*\n\s*/g, " ").trim();
    const openAttribute = node.attrs?.open ? " open" : "";
    return `<details${openAttribute}>\n<summary>${singleLineSummary}</summary>\n\n${renderedBody}\n\n</details>`;
  },

  addCommands() {
    return {
      insertCollapsibleSection:
        (options = {}) =>
        ({ commands }) => {
          const summary = (options.summary ?? "Details").replace(/\s+/g, " ").trim();
          return commands.insertContent({
            type: this.name,
            attrs: { open: options.open ?? true },
            content: [
              {
                type: "collapsibleSummary",
                content: summary ? [{ type: "text", text: summary }] : [],
              },
              { type: "collapsibleBody", content: [{ type: "paragraph" }] },
            ],
          });
        },
      setCollapsibleOpen:
        (open) =>
        ({ editor, commands }) => editor.isActive(this.name)
          && commands.updateAttributes(this.name, { open }),
      toggleCollapsibleOpen:
        () =>
        ({ editor, commands }) => {
          if (!editor.isActive(this.name)) return false;
          return commands.updateAttributes(this.name, {
            open: editor.getAttributes(this.name).open !== true,
          });
        },
    };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("details");
      dom.dataset.type = "collapsible-section";
      dom.open = node.attrs.open === true;
      let currentNode = node;

      const onToggle = () => {
        if (!editor.isEditable || currentNode.attrs.open === dom.open) return;
        try {
          const position = getPos();
          if (typeof position !== "number") return;
          const transaction = editor.state.tr.setNodeMarkup(position, undefined, {
            ...currentNode.attrs,
            open: dom.open,
          });
          editor.view.dispatch(transaction);
        } catch {
          // A queued native toggle may fire after its node was removed.
        }
      };

      dom.addEventListener("toggle", onToggle);

      return {
        dom,
        contentDOM: dom,
        update(updatedNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          dom.open = updatedNode.attrs.open === true;
          return true;
        },
        ignoreMutation(mutation) {
          return mutation.type === "attributes"
            && mutation.target === dom
            && mutation.attributeName === "open";
        },
        destroy() {
          dom.removeEventListener("toggle", onToggle);
        },
      };
    };
  },
});

/** Convenience list for direct inclusion in a Tiptap extensions array. */
export const EditorBlockExtensions = [
  Callout,
  CollapsibleSummary,
  CollapsibleBody,
  CollapsibleSection,
] as const;
