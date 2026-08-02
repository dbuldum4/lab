import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSnapshotOrder,
  selectCurrentSnapshot,
  shouldAcceptSnapshot,
  type LocalSnapshot,
} from "./local-vault.ts";

type ReplicaName = "local" | "authority" | "current" | "opfs";
type Candidate = { snapshot: LocalSnapshot; valid: boolean };
type Replica = Candidate | null;

const REPLICAS: ReplicaName[] = ["local", "authority", "current", "opfs"];
const DEFAULT_SEEDS = [0x5eedc0de, 0x71a7cafe, 0x9e3779b9, 0xc001d00d];
const DEFAULT_STEPS = 32;

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
  return Number.isFinite(value) ? value >>> 0 : DEFAULT_SEEDS[0];
}

function sameSnapshot(left: LocalSnapshot | null, right: LocalSnapshot | null) {
  if (!left || !right) return left === right;
  return left.markdown === right.markdown
    && left.updatedAt === right.updatedAt
    && left.checksum === right.checksum
    && left.version === right.version;
}

/** Independent reference ordering: timestamp, then a fixed-width hexadecimal checksum. */
function referenceCompare(left: LocalSnapshot, right: LocalSnapshot) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? 1 : -1;
  if (left.checksum === right.checksum) return 0;
  return left.checksum > right.checksum ? 1 : -1;
}

function referenceWinner(candidates: readonly (Candidate | null)[]) {
  return candidates.reduce<Candidate | null>((winner, candidate) => {
    if (!candidate?.valid) return winner;
    return !winner || referenceCompare(candidate.snapshot, winner.snapshot) > 0 ? candidate : winner;
  }, null);
}

function cloneCandidate(candidate: Candidate | null): Candidate | null {
  return candidate
    ? { valid: candidate.valid, snapshot: { ...candidate.snapshot } }
    : null;
}

type ModelState = {
  seed: number;
  clock: number;
  lastIssuedTimestamp: number;
  serial: number;
  currentDraft: string;
  pending: Candidate | null;
  acknowledged: Candidate | null;
  history: Candidate[];
  replicas: Record<ReplicaName, Replica>;
  faulted: Set<ReplicaName>;
  lastLoadWinner: Candidate | null;
};

function newModel(seed: number): ModelState {
  return {
    seed,
    clock: 1_000,
    lastIssuedTimestamp: 0,
    serial: 0,
    currentDraft: "",
    pending: null,
    acknowledged: null,
    history: [],
    replicas: { local: null, authority: null, current: null, opfs: null },
    faulted: new Set(),
    lastLoadWinner: null,
  };
}

function issueTimestamp(state: ModelState) {
  state.lastIssuedTimestamp = Math.max(state.clock, state.lastIssuedTimestamp + 1);
  return state.lastIssuedTimestamp;
}

function makeCandidate(state: ModelState, markdown: string): Candidate {
  const updatedAt = issueTimestamp(state);
  const checksum = ((Math.imul(markdown.length + 1, 0x45d9f3b) + updatedAt + state.serial) >>> 0)
    .toString(16)
    .padStart(8, "0");
  state.serial += 1;
  const candidate = {
    valid: true,
    snapshot: { markdown, updatedAt, checksum, version: 2 as const },
  };
  state.history.push(cloneCandidate(candidate) as Candidate);
  return candidate;
}

function readableCandidates(state: ModelState) {
  return REPLICAS
    .filter((name) => !state.faulted.has(name))
    .map((name) => state.replicas[name]);
}

function markUnstable(state: ModelState) {
  state.lastLoadWinner = null;
}

function stage(state: ModelState, markdown: string) {
  markUnstable(state);
  state.currentDraft = markdown;
  state.pending = makeCandidate(state, markdown);
}

function writeIfNewer(state: ModelState, name: ReplicaName, candidate: Candidate) {
  if (state.faulted.has(name)) return false;
  const current = state.replicas[name];
  if (current?.valid && referenceCompare(current.snapshot, candidate.snapshot) > 0) return false;
  state.replicas[name] = cloneCandidate(candidate);
  return true;
}

/** Model the authority transaction and best-effort replica writes without using production internals. */
function save(state: ModelState, captured: Candidate | null = state.pending) {
  markUnstable(state);
  const candidate = captured?.valid
    ? cloneCandidate(captured) as Candidate
    : makeCandidate(state, state.currentDraft);
  const durableWinner = referenceWinner(readableCandidates(state));
  const accepted = !durableWinner || referenceCompare(candidate.snapshot, durableWinner.snapshot) >= 0;

  if (accepted && !state.faulted.has("authority") && !state.faulted.has("current")) {
    state.replicas.authority = cloneCandidate(candidate);
    state.replicas.current = cloneCandidate(candidate);
    state.acknowledged = cloneCandidate(candidate);
    writeIfNewer(state, "local", candidate);
    writeIfNewer(state, "opfs", candidate);
  }
  // Save acceptance does not consume pending. A later load proves which exact
  // draft was reconciled, preserving a losing tab's recovery record.
}

function loadAndReconcile(state: ModelState) {
  const winner = referenceWinner([...readableCandidates(state), state.pending]);
  state.lastLoadWinner = cloneCandidate(winner);
  if (!winner) return;

  for (const name of REPLICAS) writeIfNewer(state, name, winner);
  const durableAfterRepair = referenceWinner(readableCandidates(state));
  if (state.pending?.valid && durableAfterRepair && sameSnapshot(state.pending.snapshot, durableAfterRepair.snapshot)) {
    state.pending = null;
  }
  state.acknowledged = cloneCandidate(durableAfterRepair);
}

function corrupt(state: ModelState, name: ReplicaName) {
  markUnstable(state);
  const current = state.replicas[name];
  const source = current?.snapshot ?? {
    markdown: `corrupt-${state.serial}`,
    updatedAt: state.lastIssuedTimestamp + 10_000,
    checksum: "ffffffff",
    version: 2 as const,
  };
  state.replicas[name] = {
    valid: false,
    snapshot: { ...source, updatedAt: source.updatedAt + 10_000, checksum: "ffffffff" },
  };
}

function stale(state: ModelState, name: ReplicaName) {
  markUnstable(state);
  const old = state.history[0];
  if (old) state.replicas[name] = cloneCandidate(old);
}

function deleteReplica(state: ModelState, name: ReplicaName) {
  markUnstable(state);
  state.replicas[name] = null;
}

function assertInvariants(state: ModelState, context: string) {
  const readable = readableCandidates(state);
  const expectedDurable = referenceWinner(readable);
  const productionWinner = selectCurrentSnapshot(
    readable
      .filter((candidate): candidate is Candidate => Boolean(candidate?.valid))
      .map((candidate) => candidate.snapshot),
  );
  assert.equal(
    sameSnapshot(productionWinner, expectedDurable?.snapshot ?? null),
    true,
    `${context}: production/reference winner mismatch`,
  );

  for (const left of readable) {
    if (!left?.valid) continue;
    for (const right of readable) {
      if (!right?.valid) continue;
      const expected = referenceCompare(left.snapshot, right.snapshot);
      assert.equal(Math.sign(compareSnapshotOrder(left.snapshot, right.snapshot)), expected, `${context}: ordering`);
      assert.equal(
        shouldAcceptSnapshot(right.snapshot, left.snapshot),
        expected >= 0,
        `${context}: acceptance`,
      );
    }
  }

  if (state.lastLoadWinner) {
    for (const name of REPLICAS) {
      if (state.faulted.has(name)) continue;
      assert.equal(
        sameSnapshot(state.replicas[name]?.valid ? state.replicas[name]?.snapshot ?? null : null, state.lastLoadWinner.snapshot),
        true,
        `${context}: readable ${name} replica did not converge`,
      );
    }
  }

  const currentDraftRecoverable = state.pending?.valid && state.pending.snapshot.markdown === state.currentDraft;
  const acknowledgedRecoverable = state.acknowledged && [
    state.pending,
    ...REPLICAS.map((name) => state.replicas[name]),
  ].some((candidate) => candidate?.valid && sameSnapshot(candidate.snapshot, state.acknowledged?.snapshot ?? null));
  const recoveryRequired = Boolean(state.pending?.valid || state.acknowledged);
  assert.equal(
    Boolean(!recoveryRequired || currentDraftRecoverable || acknowledgedRecoverable),
    true,
    `${context}: acknowledged/current draft was not recoverable`,
  );

  if (state.lastLoadWinner) {
    assert.equal(state.lastLoadWinner.valid, true, `${context}: invalid snapshot became winner`);
  }
}

function chooseReplica(random: SeededRandom) {
  return REPLICAS[random.nextInt(REPLICAS.length)];
}

function runSequence(seed: number, steps: number) {
  const random = new SeededRandom(seed);
  const state = newModel(seed);
  const operations: string[] = [];

  for (let step = 0; step < steps; step += 1) {
    const operation = random.nextInt(13);
    try {
      switch (operation) {
        case 0:
        case 1:
          stage(state, `seed-${seed.toString(16)}-edit-${step}`);
          operations.push(`stage(${state.currentDraft})`);
          break;
        case 2:
          save(state);
          operations.push("save");
          break;
        case 3:
          loadAndReconcile(state);
          operations.push("load/reconcile");
          break;
        case 4: {
          const name = chooseReplica(random);
          corrupt(state, name);
          operations.push(`corrupt(${name})`);
          break;
        }
        case 5: {
          const name = chooseReplica(random);
          deleteReplica(state, name);
          operations.push(`delete(${name})`);
          break;
        }
        case 6: {
          const name = chooseReplica(random);
          stale(state, name);
          operations.push(`stale(${name})`);
          break;
        }
        case 7: {
          const name = chooseReplica(random);
          if (state.faulted.has(name)) state.faulted.delete(name);
          else state.faulted.add(name);
          markUnstable(state);
          operations.push(`${state.faulted.has(name) ? "fail" : "recover"}(${name})`);
          break;
        }
        case 8:
          state.clock += 1 + random.nextInt(20);
          markUnstable(state);
          operations.push("clock(advance)");
          break;
        case 9:
          markUnstable(state);
          operations.push("clock(equal)");
          break;
        case 10:
          state.clock -= 1 + random.nextInt(20);
          markUnstable(state);
          operations.push("clock(backwards)");
          break;
        case 11: {
          if (!state.pending) stage(state, `seed-${seed.toString(16)}-overlap-old-${step}`);
          const older = cloneCandidate(state.pending);
          stage(state, `seed-${seed.toString(16)}-overlap-new-${step}`);
          save(state, older);
          assert.equal(state.pending?.snapshot.markdown, state.currentDraft, `seed=${seed}: older save cleared newer pending`);
          operations.push("overlap(save-old, stage-new)");
          break;
        }
        default:
          if (state.pending) {
            state.pending.valid = false;
            markUnstable(state);
            operations.push("corrupt(pending)");
          } else {
            operations.push("corrupt(pending)/noop");
          }
          break;
      }
      assertInvariants(state, `seed=${seed} step=${step} op=${operations.at(-1)}`);
    } catch (error) {
      throw new Error(
        `model failure seed=${seed} step=${step} operations=${JSON.stringify(operations)}: ${String(error)}`,
        { cause: error },
      );
    }
  }
}

const configuredSeed = process.env.LAB_MODEL_SEED;
const seeds = configuredSeed ? [parseSeed(configuredSeed)] : DEFAULT_SEEDS;
const steps = Math.min(64, Math.max(1, Number.parseInt(process.env.LAB_MODEL_STEPS ?? `${DEFAULT_STEPS}`, 10) || DEFAULT_STEPS));

test(`seeded storage reference model (${seeds.map((seed) => `0x${seed.toString(16)}`).join(", ")}, ${steps} steps)`, () => {
  for (const seed of seeds) runSequence(seed, steps);
});
