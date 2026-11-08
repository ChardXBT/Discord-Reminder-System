# Implicit State Machines — Audit

Repo: Discord-Reminder-System (Cloudflare Worker + Durable Object, 4 source files).

## 1. Discord item delivery lifecycle

**States:** `baseline` → terminal; `pending` → `sending` → `sent` | `uncertain` | back
to `pending`. Plus a **hidden 6th state**: `status='pending' AND retry_at > now()`
(rate-limit backoff), inferred from a timestamp column.

**Encoded as:** `items.status` TEXT column whose only "model" is a SQL
`CHECK (status IN ('baseline','pending','sending','sent','uncertain'))`
(`src/reminder.js:13`). The transition graph exists nowhere — it is spread
across seven `UPDATE` statements. `retry_at INTEGER` (`src/reminder.js:14`)
doubles as a phase marker: presence of a future timestamp silently re-classifies
a `pending` row as "backed off". `message_id` presence implies `sent`
(`src/reminder.js:120`).

**Invalid combos:**
- `pending` + `retry_at` in the future — representable, meaningful, but invisible
  to anyone reading the status column alone.
- `sending` persisted across a restart is not a valid state — the constructor
  forcibly rewrites it to `uncertain` (`src/reminder.js:21`).
- `uncertain` has **no outbound transition** — terminal by omission, not by design.

**Transitions:**
- INSERT as `baseline` (first scan) or `pending` — `src/reminder.js:56-58`
- `pending` → `sending` — `src/reminder.js:75`
- `sending` → `uncertain` (request threw) — `src/reminder.js:92`
- `sending` → `pending` + `retry_at` (HTTP 429) — `src/reminder.js:101`
- `sending` → `pending` (4xx rejection, then throw) — `src/reminder.js:107`
- `sending` → `uncertain` (missing/invalid message id) — `src/reminder.js:115`
- `sending` → `sent` + `message_id` — `src/reminder.js:120`
- boot repair: `sending` → `uncertain` — `src/reminder.js:21`
- reads: `WHERE status='pending'` `src/reminder.js:71`; backoff gate `src/reminder.js:74`;
  `COUNT(*) ... status='uncertain'` `src/reminder.js:126`

**Risk (HIGH):** `uncertain` is a dead end — no code path ever updates an
`uncertain` row, so a single ambiguous Discord delivery makes every subsequent
cron run return `needs-review` and throw (`src/worker.js:28`) forever; the
Worker is permanently stuck until someone hand-edits the Durable Object's SQL
table. **(MED):** head-of-line blocking — when the earliest-rowid `pending`
item is in backoff, `src/reminder.js:74` *returns* instead of skipping it, so
all later deliverable items starve until `retry_at` passes. **(MED):** a restart
mid-delivery marks the row `uncertain` even when Discord actually received it —
a delivered item permanently fails the schedule.

## 2. Slot/run progress via settings-key presence

**States:** uninitialized (no `channel` key) → scanned (`scanned_slot == slot`,
`completed_slot != slot`) → done (`completed_slot == slot`), with a separate
once-only `destination` binding.

**Encoded as:** presence/absence and string equality over four `settings` rows —
no declared phase model. `first = !channel` (`src/reminder.js:53`) infers
"first ever run" from a missing key; `scanned_slot !== slot` gates the snapshot
phase (`src/reminder.js:49`); `completed_slot === slot` short-circuits the run
(`src/reminder.js:39`); `destination` presence means the webhook is bound
(`src/reminder.js:40`).

**Invalid combos:** `completed_slot == slot` while `pending`/`sending` rows
remain is not reachable today only because write ordering inside
`transactionSync`/`check` happens to prevent it — nothing declares that
invariant. Note the model mixes scopes: slot-scoped keys vs. a *global* item
queue (`pending` rows are not per-slot). A future edit reordering the writes at
`src/reminder.js:61-65` vs `src/reminder.js:124` silently shifts the machine.

**Transitions:** `channel`/`destination`/`completed_slot`/`scanned_slot` written
on first run — `src/reminder.js:61-65`; `completed_slot` on drain —
`src/reminder.js:124`; read gates at `src/reminder.js:39-40, 49-53`.

**Risk (MED):** resume correctness depends entirely on cross-row write ordering;
`!channel` conflates "never scanned" with "baseline mode", so losing that one
key silently re-baselines and binds to a new channel/destination check.

## 3. Run-result status vocabulary

**States:** `already-checked`, `outside-window`, `baseline`, `pending`,
`rate-limited`, `needs-review`, `complete` — 7 outcome strings.

**Encoded as:** raw string literals in ~9 `return { status: ... }` sites
(`src/reminder.js:39, 68, 73, 74, 103, 127`, `src/worker.js:14`); only
`needs-review` is ever compared (`src/worker.js:28`). No enum or constant list
defines the vocabulary; the `status` key is also overloaded — it means item
lifecycle in the DB and run outcome in the return value.

**Risk (LOW):** any new consumer must guess the string set; a typo'd comparison
(e.g. `'rate_limited'`) fails silently.
