export type CommandContext = {
  inTable: boolean;
  inCodeBlock: boolean;
  inLink: boolean;
  selectedImage: boolean;
};

export type CommandAvailability = {
  available: boolean;
  reason?: string;
};

export type CommandLike = {
  id: string;
  label: string;
  terms: string;
};

export type RankedCommand<T extends CommandLike> = {
  command: T;
  availability: CommandAvailability;
};

const TABLE_COMMANDS = new Set([
  "table-row-before",
  "table-row-after",
  "table-delete-row",
  "table-column-before",
  "table-column-after",
  "table-delete-column",
  "table-toggle-header",
  "table-delete",
]);

const TABLE_REASON = "Place the caret inside a table first.";
const NESTED_TABLE_REASON = "Nested tables are not portable.";

export function commandAvailability(commandId: string, context: CommandContext): CommandAvailability {
  if (TABLE_COMMANDS.has(commandId) && !context.inTable) {
    return { available: false, reason: TABLE_REASON };
  }
  if (commandId === "table" && context.inTable) {
    return { available: false, reason: NESTED_TABLE_REASON };
  }
  if (commandId === "edit-link" && !context.inLink) {
    return { available: false, reason: "Place the caret inside a link first." };
  }
  if (commandId === "image-metadata" && !context.selectedImage) {
    return { available: false, reason: "Select an image first." };
  }
  return { available: true };
}

function commandMatchScore(command: CommandLike, query: string): number {
  if (!query) return 0;
  if (normalizeSearchText(command.id) === query) return 0;
  if (normalizeSearchText(command.label).startsWith(query)) return 1;
  return 2;
}

/**
 * Keep unavailable context-specific commands discoverable, but after commands
 * that can run now. The result carries availability so the UI can avoid
 * selecting or executing disabled options without duplicating the rules.
 */
export function rankCommands<T extends CommandLike>(
  commands: readonly T[],
  rawQuery: string,
  context: CommandContext,
): RankedCommand<T>[] {
  const query = normalizeSearchText(rawQuery);
  return commands
    .filter((command) => normalizeSearchText(
      `${command.id} ${command.label} ${command.terms}`,
    ).includes(query))
    .map((command, index) => ({
      command,
      availability: commandAvailability(command.id, context),
      index,
    }))
    .sort((left, right) => (
      Number(!left.availability.available) - Number(!right.availability.available)
      || commandMatchScore(left.command, query) - commandMatchScore(right.command, query)
      || left.index - right.index
    ))
    .map(({ command, availability }) => ({ command, availability }));
}
import { normalizeSearchText } from "./search-normalization.ts";
