# Spec: bounded incremental scans (not built)

Status: proposed, 2026-11-17. Per the owner's scope rule, this is a spec, not an implementation.

## Problem

Every eligible check pages through the **entire** Shorts and Posts archives (`src/youtube.js`, `fetchSource`).
The per-invocation budget is 48 external requests (`MAX_REQUESTS` in `src/reminder.js`), shared with Discord
deliveries. A live read-only check on 2026-11-17 measured full scans of:

| Channel | Requests | Items |
| --- | --- | --- |
| `@Qlob` (the example channel) | 24 | 101 Shorts, 200 posts |
| `@MrBeast` | 14 | 207 Shorts, 87 posts |
| `@mkbhd` | 9 | 125 Shorts, 41 posts |

As an archive grows, the scan eventually exceeds the budget. Every check then fails with
`Request budget exceeded; snapshot was not saved` and nothing is announced, with no partial progress saved. This
is safe (fail-closed), but notifications stop until the code changes.

## Proposed behaviour

1. After the baseline, stop paginating a source once a page contains only known IDs **and** at least
   N (e.g. 2) consecutive pages were fully known. Pinned posts appear first, so the rule must not stop on the first
   known item.
2. Run a full scan only occasionally (for example, once a day or every K-th slot) to catch reordered or
   reappearing content, and allow it to continue across ticks via a persisted continuation cursor.
3. Keep the existing guarantees: no partial baseline; channel identity check on every scan; deliveries
   never replayed.

## Acceptance tests

- An archive needing more than 48 requests still announces new items at the top of either tab.
- A new item behind a pinned known post is detected.
- A failed full rescan keeps incremental detection working and never saves a partial baseline.
- Request count per invocation stays at or below `MAX_REQUESTS`.
