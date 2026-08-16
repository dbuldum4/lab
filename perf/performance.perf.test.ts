import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  searchableMarkdown,
  searchLocalDocuments,
  type LocalSearchDocument,
} from "../lib/local-search.ts";
import {
  activeOutlineIndex,
  areOutlineItemsEqual,
  buildOutline,
  type OutlineHeadingInput,
} from "../lib/outline.ts";
import {
  buildVaultBackup,
  parseVaultBackup,
  serializeVaultBackup,
} from "../lib/vault-backup.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordPerformanceMetric } from "./results.ts";
import { summarizeSamples, type SampleSummary } from "./statistics.ts";

type BenchmarkOptions = {
  warmups?: number;
  samples?: number;
  iterations?: number;
};

type BenchmarkResult<T> = {
  name: string;
  value: T;
  samples: number[];
  summary: SampleSummary;
};

const SEARCH_SESSION_COUNT = 2_000;
const OUTLINE_HEADING_COUNT = 12_000;
const BACKUP_SESSION_COUNT = 2_000;
const PERF_SAMPLES = Number.parseInt(process.env.LAB_PERF_UNIT_SAMPLES ?? "11", 10);
const PIXEL_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

if (!Number.isInteger(PERF_SAMPLES) || PERF_SAMPLES < 5) {
  throw new Error("LAB_PERF_UNIT_SAMPLES must be an integer of at least 5.");
}

function benchmark<T>(
  id: string,
  name: string,
  operation: () => T,
  { warmups = 2, samples = PERF_SAMPLES, iterations = 1 }: BenchmarkOptions = {},
): BenchmarkResult<T> {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("Benchmark iterations must be a positive integer.");
  }
  for (let warmup = 0; warmup < warmups; warmup += 1) {
    for (let iteration = 0; iteration < iterations; iteration += 1) operation();
  }

  const durations: number[] = [];
  let value: T;
  for (let sample = 0; sample < samples; sample += 1) {
    const startedAt = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) value = operation();
    durations.push((performance.now() - startedAt) / iterations);
  }

  const summary = summarizeSamples(durations);
  const result = {
    name,
    value: value!,
    samples: durations,
    summary,
  };
  recordPerformanceMetric({
    id,
    label: name,
    source: "unit",
    samplesMs: durations,
    details: { iterationsPerSample: iterations },
  });
  return result;
}

const SCORE_BASELINE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "score-baseline.json"), "utf8"),
) as { metrics: Array<{ id: string; baselineMs: number }> };

function unitBudgetMs(metricId: string) {
  const baselineMs = SCORE_BASELINE.metrics.find((metric) => metric.id === metricId)?.baselineMs;
  if (!Number.isFinite(baselineMs) || (baselineMs ?? 0) <= 0) {
    throw new Error(`Missing committed baseline for ${metricId}`);
  }
  // Score baselines are quiet-machine numbers; keep a large-regression gate
  // that still fails before the old 400–650× ceilings.
  return Math.max(50, Math.ceil((baselineMs as number) * 200));
}

function assertBudget(result: BenchmarkResult<unknown>, budgetMs: number) {
  if (process.env.LAB_PERF_REPORT_ONLY === "1") return;
  assert.ok(
    result.summary.median <= budgetMs,
    `${result.name} exceeded its ${budgetMs}ms median budget: ${result.summary.median.toFixed(2)}ms`,
  );
}

function searchMarkdown(index: number) {
  return [
    `# Notebook ${index}`,
    "",
    `Shared token corpus entry ${index}. The searchable body contains needle-${index}.`,
    `- shared checklist item ${index}`,
    `- launch context for notebook ${index}`,
    "",
    `[reference ${index}](https://example.test/notes)`,
    "",
    "```text",
    `literal code sample ${index}`,
    "```",
  ].join("\n");
}

const SEARCH_MARKDOWN = Array.from({ length: SEARCH_SESSION_COUNT }, (_, index) => searchMarkdown(index));
const SEARCH_DOCUMENTS: LocalSearchDocument[] = SEARCH_MARKDOWN.map((markdown, index) => ({
  id: `session-${index}`,
  name: `Notebook ${index}`,
  markdown,
  searchableText: searchableMarkdown(markdown),
  updatedAt: 1_700_000_000_000 + index,
}));

const OUTLINE_HEADINGS: OutlineHeadingInput[] = Array.from(
  { length: OUTLINE_HEADING_COUNT },
  (_, index) => ({
    level: ([1, 2, 3] as const)[index % 3]!,
    title: `  Section ${index}\nwith supporting detail  `,
    position: index * 4,
  }),
);

const BACKUP_SESSIONS = Array.from({ length: BACKUP_SESSION_COUNT }, (_, index) => ({
  id: index === 0 ? "default" : `session-${index}`,
  name: `Notebook ${index}`,
  createdAt: 1_700_000_000_000 + index,
  updatedAt: 1_700_100_000_000 + index,
  markdown: [
    `# Backup note ${index}`,
    "",
    `Shared backup token ${index} with enough body text to exercise the full vault pipeline.`,
    ...Array.from({ length: 8 }, (_, line) => (
      `- checklist ${line} for session ${index}; preserve this content during restore`
    )),
    index % 11 === 0 ? `![pixel](${PIXEL_IMAGE})` : "",
    `backup-marker-${index}`,
  ].filter(Boolean).join("\n"),
}));

test("full-vault search remains responsive across the maximum session catalog", () => {
  const result = benchmark(
    "unit-search",
    "search 2,000 indexed sessions across common and sparse queries",
    () => {
      const common = searchLocalDocuments(SEARCH_DOCUMENTS, "shared token");
      const sparse = searchLocalDocuments(SEARCH_DOCUMENTS, `needle-${SEARCH_SESSION_COUNT - 1}`);
      const nameOnly = searchLocalDocuments(SEARCH_DOCUMENTS, `Notebook ${SEARCH_SESSION_COUNT - 1}`);
      return { common, sparse, nameOnly };
    },
    { iterations: 20 },
  );

  assert.equal(result.value.common.length, SEARCH_SESSION_COUNT);
  assert.equal(result.value.sparse.length, 1);
  assert.equal(result.value.sparse[0]?.documentId, `session-${SEARCH_SESSION_COUNT - 1}`);
  assert.equal(result.value.nameOnly.length, 1);
  assert.equal(result.value.nameOnly[0]?.match, "name-and-content");
  assertBudget(result, unitBudgetMs("unit-search"));
});

test("full-vault search indexing normalizes every Markdown snapshot within budget", () => {
  const result = benchmark(
    "unit-search-index",
    "normalize Markdown for a 2,000-session search index",
    () => SEARCH_MARKDOWN.map((markdown) => searchableMarkdown(markdown)),
    { iterations: 8 },
  );

  assert.equal(result.value.length, SEARCH_SESSION_COUNT);
  assert.ok(result.value.every((text) => text.length > 0));
  assertBudget(result, unitBudgetMs("unit-search-index"));
});

test("outline rebuild and active-heading lookup handle a large document", () => {
  const buildResult = benchmark(
    "unit-outline-build",
    "build outline for 12,000 headings",
    () => buildOutline(OUTLINE_HEADINGS),
    { iterations: 10 },
  );
  const outline = buildResult.value;

  assert.equal(outline.length, OUTLINE_HEADING_COUNT);
  assert.equal(outline[0]?.title, "Section 0 with supporting detail");
  assert.equal(outline.at(-1)?.depth, (OUTLINE_HEADING_COUNT - 1) % 3);
  assertBudget(buildResult, unitBudgetMs("unit-outline-build"));

  const positions = Array.from({ length: 1_024 }, (_, index) => (
    (index * 47) % (OUTLINE_HEADING_COUNT * 4 + 1)
  ));
  const activeResult = benchmark(
    "unit-outline-active",
    "resolve 1,024 active-heading positions in a 12,000-heading outline",
    () => positions.reduce((total, position) => total + activeOutlineIndex(outline, position), 0),
    { iterations: 6 },
  );

  assert.notEqual(activeResult.value, 0);
  assert.equal(activeOutlineIndex(outline, -1), -1);
  assert.equal(activeOutlineIndex(outline, (OUTLINE_HEADING_COUNT - 1) * 4), OUTLINE_HEADING_COUNT - 1);
  assertBudget(activeResult, unitBudgetMs("unit-outline-active"));

  const copiedOutline = outline.map((item) => ({ ...item }));
  const equalityResult = benchmark(
    "unit-outline-compare",
    "compare cached 12,000-item outlines",
    () => areOutlineItemsEqual(outline, copiedOutline),
    { iterations: 300 },
  );
  assert.equal(equalityResult.value, true);
  assertBudget(equalityResult, unitBudgetMs("unit-outline-compare"));
});

test("large vault backups build, serialize, and validate within budget", () => {
  const buildResult = benchmark(
    "unit-backup-build",
    "build backup for 2,000 sessions with deduplicated images",
    () => buildVaultBackup(BACKUP_SESSIONS, 1_800_000_000_000),
    { iterations: 5 },
  );
  const backup = buildResult.value;

  assert.equal(backup.counts.sessions, BACKUP_SESSION_COUNT);
  assert.equal(backup.counts.assets, 1);
  assert.equal(backup.assets[0]?.dataUrl, PIXEL_IMAGE);
  assert.match(backup.sessions[0]?.markdown ?? "", /lab-asset:\/\/asset-1/);
  assertBudget(buildResult, unitBudgetMs("unit-backup-build"));

  const serialized = serializeVaultBackup(backup);
  const serializeResult = benchmark(
    "unit-backup-serialize",
    "serialize and revalidate a 2,000-session backup",
    () => serializeVaultBackup(backup),
    { iterations: 5 },
  );
  assert.equal(serializeResult.value, serialized);
  assertBudget(serializeResult, unitBudgetMs("unit-backup-serialize"));

  const parseResult = benchmark(
    "unit-backup-parse",
    "parse and validate a serialized 2,000-session backup",
    () => parseVaultBackup(serialized),
    { iterations: 5 },
  );
  assert.equal(parseResult.value.counts.sessions, BACKUP_SESSION_COUNT);
  assert.equal(parseResult.value.counts.assets, 1);
  assertBudget(parseResult, unitBudgetMs("unit-backup-parse"));
});
