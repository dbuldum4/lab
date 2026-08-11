# Performance tests

Run this command to get the one aggregate performance index:

```bash
npm run perf:score
```

The command builds the production app and runs all 28 weighted metrics. Its
browser tests use one Chromium worker. The metrics cover large-page typing,
paint, load, paste, scroll, outline use, replace, undo, redo, durable save,
difficult document shapes, repeated paste, search, indexing, outline work, and
backup work.

The final result is one number from 1 to 100:

- 50.0 is the committed August 2026 calibration on the current code.
- A higher number is better.
- 100 is the theoretical result when all measured latency approaches zero.
- 1 is the floor for a severe regression.

The formula is:

```text
clamp(1, 100, 100 - 50 * weighted mean(current latency / baseline latency))
```

The output also shows each raw metric, its change from its baseline, and its
weight. These lines explain the aggregate. They are not separate indexes.

Weights and baseline values are in `perf/score-baseline.json`. The weights sum
to 100. Interactive work has the most weight. In particular, typing through
paint has the largest weight.

Raw samples are saved in `.perf-results/latest.ndjson`. The aggregate and its
diagnostic data are saved in `.perf-results/latest-score.json`.

## Agent hill-climb loop

Use the same machine for the unchanged and changed runs. Close expensive apps,
connect power, disable low-power mode, and wait for background work to settle.
Then use this loop:

1. Run `npm run perf:score` on unchanged code.
2. Make one performance change.
3. Run `npm run perf:score` again.
4. Keep the change only when the aggregate improves and the raw output does not
   show a serious regression in a critical interaction.
5. Repeat a promising result at least once before committing it.

For unattended work, use a dedicated bare-metal runner when possible. A quiet,
fixed-performance laptop is better than a shared VPS. A dedicated VPS can work,
but noisy neighbors can change CPU time without warning. Do not compare scores
from different machine types against this calibration.

## Shorter diagnostic runs

These commands do not produce the aggregate index:

```bash
npm run test:perf:unit
npm run test:perf:e2e
npm run test:perf:extended
```

Use them to investigate a specific layer. Use `npm run perf:score` for the final
hill-climb decision.
