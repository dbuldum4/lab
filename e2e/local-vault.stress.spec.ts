import { expect, test, type Page } from "@playwright/test";

const PENDING_PREFIX = "lab.document.pending.v2.";

type PendingRecord = {
  storageKey: string;
  markdown: string;
  updatedAt: number;
  snapshotChecksum: string;
};

type Schedule = {
  seed: number;
  iteration: number;
  fixedNow: number;
  mode: "parallel" | "A-then-B" | "B-then-A" | "A-commit-then-B" | "B-commit-then-A";
  delayA: number;
  delayB: number;
};

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextInt(maxExclusive: number) {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state % maxExclusive;
  }
}

function parseSeed(raw: string | undefined) {
  const value = Number.parseInt(raw ?? "", raw?.startsWith("0x") ? 16 : 10);
  return Number.isFinite(value) ? value >>> 0 : 0x20260802;
}

function boundedIterations(raw: string | undefined) {
  const value = Number.parseInt(raw ?? "8", 10);
  return Math.min(24, Math.max(1, Number.isFinite(value) ? value : 8));
}

async function openEditor(page: Page) {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "lab local-only Markdown note" });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 });
  return editor;
}

async function authorityMarkdown(page: Page) {
  return page.evaluate(() => new Promise<string | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open("lab-private-vault");
    } catch {
      resolve(null);
      return;
    }
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const database = request.result;
      try {
        const transaction = database.transaction("documents", "readonly");
        const read = transaction.objectStore("documents").get("authority");
        read.onsuccess = () => resolve((read.result as { snapshot?: { markdown?: string } } | undefined)?.snapshot?.markdown ?? null);
        read.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
        transaction.onerror = () => resolve(null);
        transaction.oncomplete = () => database.close();
      } catch {
        database.close();
        resolve(null);
      }
    };
  }));
}

async function pendingRecords(page: Page) {
  return page.evaluate(async ({ prefix }) => {
    const records = Object.keys(localStorage)
      .filter((key) => key.startsWith(prefix))
      .map((storageKey) => ({ storageKey, ...JSON.parse(localStorage.getItem(storageKey) ?? "null") })) as PendingRecord[];
    return Promise.all(records.map(async (record) => {
      const bytes = new TextEncoder().encode(JSON.stringify(["lab.snapshot.v2", record.updatedAt, record.markdown]));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const snapshotChecksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      return { ...record, snapshotChecksum };
    }));
  }, { prefix: PENDING_PREFIX });
}

async function editorText(page: Page) {
  return page.getByRole("textbox", { name: "lab local-only Markdown note" }).textContent();
}

async function dispatchPagehide(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
}

function nextSchedule(random: SeededRandom, seed: number, iteration: number): Schedule {
  const modes: Schedule["mode"][] = [
    "parallel",
    "A-then-B",
    "B-then-A",
    "A-commit-then-B",
    "B-commit-then-A",
  ];
  return {
    seed,
    iteration,
    fixedNow: 1_750_000_000_000 + iteration,
    mode: modes[random.nextInt(modes.length)],
    delayA: 20 + random.nextInt(220),
    delayB: 20 + random.nextInt(220),
  };
}

async function runSchedule(pageA: Page, pageB: Page, schedule: Schedule, markdownA: string, markdownB: string) {
  if (schedule.mode === "parallel") {
    await Promise.all([dispatchPagehide(pageA), dispatchPagehide(pageB)]);
    return;
  }
  if (schedule.mode === "A-then-B") {
    await dispatchPagehide(pageA);
    await dispatchPagehide(pageB);
    return;
  }
  if (schedule.mode === "B-then-A") {
    await dispatchPagehide(pageB);
    await dispatchPagehide(pageA);
    return;
  }

  if (schedule.mode === "A-commit-then-B") {
    await expect.poll(() => authorityMarkdown(pageA), { timeout: 15000, intervals: [25, 50, 100, 250] }).toBe(markdownA);
    await dispatchPagehide(pageB);
    return;
  }

  await expect.poll(() => authorityMarkdown(pageB), { timeout: 15000, intervals: [25, 50, 100, 250] }).toBe(markdownB);
  await dispatchPagehide(pageA);
}

test("@stress repeated two-tab conflicts converge and preserve the loser draft", async ({ browser }) => {
  test.setTimeout(120_000);
  const seed = parseSeed(process.env.LAB_STRESS_SEED);
  const iterations = boundedIterations(process.env.LAB_STRESS_ITERATIONS);
  const random = new SeededRandom(seed);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const schedule = nextSchedule(random, seed, iteration);
    const context = await browser.newContext();
    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      await pageA.addInitScript(({ fixedNow, delay }) => {
        Date.now = () => fixedNow;
        (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = delay;
      }, { fixedNow: schedule.fixedNow, delay: schedule.delayA });
      await pageB.addInitScript(({ fixedNow, delay }) => {
        Date.now = () => fixedNow;
        (window as Window & { __LAB_E2E_SAVE_DELAY__?: number }).__LAB_E2E_SAVE_DELAY__ = delay;
      }, { fixedNow: schedule.fixedNow, delay: schedule.delayB });

      const [editorA, editorB] = await Promise.all([openEditor(pageA), openEditor(pageB)]);
      const markdownA = `stress A ${iteration}`;
      const markdownB = `stress B ${iteration}`;
      await Promise.all([editorA.fill(markdownA), editorB.fill(markdownB)]);
      await expect.poll(async () => (await pendingRecords(pageA)).length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);

      const candidates = await pendingRecords(pageA);
      const winner = [...candidates].sort((left, right) => (
        right.updatedAt - left.updatedAt || right.snapshotChecksum.localeCompare(left.snapshotChecksum)
      ))[0];
      expect(winner).toBeDefined();
      expect(candidates.some((candidate) => candidate.markdown === markdownA)).toBe(true);
      expect(candidates.some((candidate) => candidate.markdown === markdownB)).toBe(true);

      await runSchedule(pageA, pageB, schedule, markdownA, markdownB);
      await expect.poll(() => authorityMarkdown(pageA), { timeout: 15000, intervals: [25, 50, 100, 250] }).toBe(winner.markdown);

      await Promise.all([pageA.reload(), pageB.reload()]);
      await Promise.all([
        expect(pageA.getByRole("textbox", { name: "lab local-only Markdown note" })).toBeVisible(),
        expect(pageB.getByRole("textbox", { name: "lab local-only Markdown note" })).toBeVisible(),
      ]);
      await expect.poll(() => editorText(pageA), { timeout: 10000 }).toBe(winner.markdown);
      await expect.poll(() => editorText(pageB), { timeout: 10000 }).toBe(winner.markdown);
      const remaining = await pendingRecords(pageA);
      expect(remaining.some((candidate) => candidate.markdown !== winner.markdown)).toBe(true);
    } catch (error) {
      throw new Error(
        `stress failure seed=${seed} iteration=${iteration} schedule=${JSON.stringify(schedule)}: ${String(error)}`,
        { cause: error },
      );
    } finally {
      await context.close();
    }
  }
});
