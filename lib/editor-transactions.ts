import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

const DOLLAR_CONTEXT_RADIUS = 2;

function rangeTouchesHeading(doc: PMNode, from: number, to: number) {
  const start = Math.max(0, Math.min(from, doc.content.size));
  const end = Math.max(start, Math.min(to, doc.content.size));
  if (doc.resolve(start).parent.type.name === "heading") return true;
  if (end > start && doc.resolve(end).parent.type.name === "heading") return true;

  let found = false;
  if (end > start) {
    doc.nodesBetween(start, end, (node) => {
      if (node.type.name === "heading") found = true;
    });
  }
  return found;
}

function headingNodes(doc: PMNode) {
  const nodes: Array<{ node: PMNode; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") nodes.push({ node, pos });
  });
  return nodes;
}

function headingsChanged(before: PMNode, after: PMNode) {
  const beforeHeadings = headingNodes(before);
  const afterHeadings = headingNodes(after);
  if (beforeHeadings.length !== afterHeadings.length) return true;
  return beforeHeadings.some(({ node, pos }, index) => {
    const next = afterHeadings[index];
    return !next || next.pos !== pos || !node.eq(next.node);
  });
}

/** Check each step against the document that exists at that step. */
export function transactionTouchesHeading(transaction: Transaction) {
  if (!transaction.docChanged) return false;

  for (let index = 0; index < transaction.mapping.maps.length; index += 1) {
    const map = transaction.mapping.maps[index];
    const before = transaction.docs[index] ?? transaction.before;
    const after = transaction.docs[index + 1] ?? transaction.doc;
    let found = false;
    let hasRanges = false;

    map.forEach((oldStart, oldEnd, newStart, newEnd) => {
      hasRanges = true;
      if (
        rangeTouchesHeading(before, oldStart, oldEnd)
        || rangeTouchesHeading(after, newStart, newEnd)
      ) {
        found = true;
      }
    });
    if (found) return true;
    if (!hasRanges && headingsChanged(before, after)) return true;
  }
  return false;
}

function textAround(doc: PMNode, from: number, to: number) {
  const start = Math.max(0, Math.min(from - DOLLAR_CONTEXT_RADIUS, doc.content.size));
  const end = Math.max(start, Math.min(Math.max(from, to) + DOLLAR_CONTEXT_RADIUS, doc.content.size));
  return end > start ? doc.textBetween(start, end, "\n", "\ufffc") : "";
}

/** Detect dollar edits, including deletions that join existing delimiters. */
export function transactionContainsDollar(transaction: Transaction) {
  if (!transaction.docChanged) return false;

  for (let index = 0; index < transaction.mapping.maps.length; index += 1) {
    const map = transaction.mapping.maps[index];
    const after = transaction.docs[index + 1] ?? transaction.doc;
    let found = false;

    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const insertedText = newEnd > newStart
        ? after.textBetween(newStart, newEnd, "\n", "\ufffc")
        : "";
      if (insertedText.includes("$") || textAround(after, newStart, newEnd).includes("$")) {
        found = true;
      }
    });
    if (found) return true;
  }
  return false;
}
