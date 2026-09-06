# API read and execution performance — 2026-09-06

## Dataset and method

These scripts create and remove their own temporary SQLite databases and never contact a provider or open the operator database:

```sh
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/tests/benchmarks/snapshotPagination.ts
node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/tests/benchmarks/evaluationCounters.ts
```

Run from the repository root using the project's supported Node version. For comparison with commit `bb70a16`, export its repository module to a temporary `.mts` file, rewriting its relative source imports to the current checkout's absolute `apps/api/src/` directory:

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess
import tempfile
baseline = Path(tempfile.gettempdir()) / 'denicheur-repository-baseline.mts'
source = subprocess.check_output(['git', 'show', 'bb70a16:apps/api/src/repository.ts'], text=True)
baseline.write_text(source.replace('from "./', 'from "' + str(Path.cwd() / 'apps/api/src') + '/'))
print(baseline)
PY
```

Set `BENCH_BASELINE_MODULE` to the printed absolute file path for either benchmark command. The baseline uses the same SQLite/data/fixtures and current unchanged supporting modules. Timing is diagnostic, without brittle CI thresholds; regression tests check exact frozen values, bounded statement counts, cache sharing and absence of history JSON parsing.

One local Node 26.5.0 run on 2026-09-06 measured the following milliseconds. Catalog fixtures contain 100/1,000/5,000 properties with approximately 1.9 KiB descriptions, two linked photos and an evaluation each. Page size is 50; each of five new-revision reads follows a batch of 20 listing updates. Warm values are medians of 100 reads after 20 warmups.

| Catalog rows | Baseline first-page new revision | Initial immutable projection | New revision with sharing | Warm snapshot |
|---:|---:|---:|---:|---:|
| 100 | 2.56 | 9.45 | 2.30 | 1.08 |
| 1,000 | 2.35 | 26.18 | 7.25 | 1.08 |
| 5,000 | 6.59 | 130.41 | 32.30 | 1.12 |

At 5,000 rows, a warm baseline page took 6.65 ms; the initial compact map took 89.24 ms, a 20-update map revision 23.77 ms, and unchanged conditional access 0.05 ms. Six full snapshots represented 103.83 MB of logical references while all shared full/map versions after the additional map update occupied 21.04 MB of actual payload. The database/WAL files were 80.41/51.43 MB versus baseline 50.49/51.03 MB for this short synthetic run. The initial whole-payload-copy design took 122–147 ms on each revision at this size; shared versions remove most of that repeated work but do not eliminate the synchronous ordering cost. These are local microbenchmarks, not production latency or provider validation.

The counter fixture completes 100/500/1,000 results with approximately 1.6 KiB summaries and a mix of successful decisions/failed steps. Provider calls and real media transfer are excluded.

| Results | Baseline all checkpoints (ms) | Scalar all checkpoints (ms) | Baseline last 10 median (ms) | Scalar last 10 median (ms) |
|---:|---:|---:|---:|---:|
| 100 | 38.42 | 13.51 | 0.543 | 0.104 |
| 500 | 419.33 | 58.97 | 1.414 | 0.097 |
| 1,000 | 1,546.65 | 116.58 | 3.355 | 0.096 |

At 1,000 results, finalization took 4.02 ms in the baseline versus 0.99 ms with scalar columns.

## Scope and validation

The API suite passed 309 tests, with the two opt-in MinIO integration tests skipped. New regressions cover both directions of all seven listing sorts, membership/order/JSON stability across second-connection writes, query mismatch, legacy/expired cursor errors, restart, LRU/size rollback, shared payload cleanup, unknown-last sorting with zero and null scores, execution filter/counter/budget snapshots, HTTP auth/CORS/ETag, counter overwrite/replay, cancellation/ownership checks and legacy result migration. API test typechecking and whitespace checks passed.

Read semantics and capacity limits are documented in [the API README](../apps/api/README.md#stable-catalog-and-history-reads). The retained snapshot freezes JSON, not lifetime of referenced media binaries. Initial or changed-revision snapshots still use synchronous SQLite work proportional to the matching catalog; resource caps bound retained payloads and references, not a maximum request duration. CPU contention, storage performance, larger galleries/evaluations and much bigger histories can change these measurements. No real operator database, provider, deployed API or production traffic was used.
