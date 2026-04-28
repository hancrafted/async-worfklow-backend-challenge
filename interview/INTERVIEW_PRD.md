# Interview Documentation Polish — PRD

> **Status:** Planning artifact for the rebuild of `interview/` and the new
> `interview.md` at repo root. Synthesized from a 9-round grill on
> 2026-04-28. Locked decisions live in `## Implementation Decisions` below.
> Once the work is done, this PRD is *historical* — `interview.md` is the
> reviewer-facing entry point.

## Problem Statement

The interviewer who clones this repo today lands on `Readme.md` (the original
challenge brief), `PRD.md` (303 lines, dense), `CLAUDE.md` (workflow rules),
and an `interview/` tree with ~25 files of accreted history (per-wave manual
test plans, per-objection defense notes, sprawling `design_decisions.md`).
There is **no single document that orients them in 5–10 minutes**, no
**executable verification path** for the README's six requirements, and
**no compact digest of the design trade-offs** they're most likely to grill on.
The author is not in the room when they read; everything has to stand alone.

## Solution

Build `interview.md` at the repo root as the **single skim-then-drill entry
point** for the interviewer, backed by:

- A rebuilt `interview/manual_test_plan/` with **one happy + one sad shell
  script per README requirement (§1–§6)** that print `[PASS]`/`[FAIL]`
  evidence and exit non-zero on failure — so the reviewer can verify each
  requirement without copy-pasting curl snippets.
- An **archived** `interview/archive/` containing every existing file (with a
  `CLAUDE.md` marker) so the historical context is preserved but the
  reviewer's reading path is uncluttered.
- **Two mermaid diagrams** in `interview.md`: a planning timeline (Readme →
  PRD → issues → CLAUDE.md → TDD per ticket → hardening → manual test plan)
  and a feedback-loop graph (pre-commit / pre-push / HITL / manual test plan
  / PR review).
- A **design digest** of 5–8 most-grillable decisions plus a `pushback →
  defense file` table that makes the per-objection notes
  (`no-lease-and-heartbeat.md`, `no-task-output-column.md`,
  `coroutine-vs-thread.md`) discoverable.

## User Stories

1. As an interviewer, I want a single root file (`interview.md`) that orients me in 5–10 minutes, so that I can prepare for the call without crawling 25 files.
2. As an interviewer, I want to verify each README requirement (§1–§6) by running one shell script per happy/sad path, so that I can confirm the system works without writing curl commands myself.
3. As an interviewer, I want every script to print observable evidence AND a `[PASS]`/`[FAIL]` verdict line, so that I can both audit *what* was checked and skim *whether* it passed.
4. As an interviewer, I want scripts to exit non-zero on failure, so that I can run all 12 in a batch loop and get a one-glance smoke verdict.
5. As an interviewer, I want a planning-process diagram that shows how the work was decomposed (Readme → PRD → issues → tickets), so that I can judge planning discipline.
6. As an interviewer, I want a feedback-loop diagram that shows how quality gates and HITL checkpoints actually fired during execution, so that I can judge execution discipline separately from planning.
7. As an interviewer, I want a digest of the 5–8 most-defended design decisions in `interview.md`, so that I can identify the senior trade-offs without reading 280 lines of `design_decisions.md`.
8. As an interviewer, I want a `pushback → defense file` table, so that I can find the prepared rebuttal for any objection I'm about to raise.
9. As an interviewer, I want the per-task manual test plan `.md` files to focus on *rationale* (what does this script prove?), not boilerplate (curl + jq + sqlite plumbing), so that I'm not re-reading the same setup five times.
10. As an interviewer, I want a thin `manual_test_plan/README.md` redirect, so that if I `cd` into the folder directly I'm not stuck in a 404 in my head.
11. As an interviewer, I want all 12 scripts to share helpers in `_lib.sh`, so that they read like test cases instead of test plumbing.
12. As an interviewer, I want an optional `00_reset.sh`, so that I can nuke server + DB and start fresh if I want a final clean run.
13. As a future maintainer (agent or human), I want the archived tree under `interview/archive/CLAUDE.md` to be unambiguously labeled as historical, so that I never quote it as the current state.
14. As the author, I want `INTERVIEW_PRD.md` itself preserved in `interview/`, so that the *meta-process* (how the interview docs were built) is auditable.

## Implementation Decisions

### Folder layout (locked Q3)

- Move every existing file under `interview/` into `interview/archive/`, **preserving subfolder structure**. Add `interview/archive/CLAUDE.md` containing exactly: *"This folder is archived. The current interview-facing documentation lives in `/interview.md` (root) and the rebuilt files alongside this folder. Do NOT cite anything in `archive/` as the current state of the project."*
- Rebuild fresh under `interview/`: `INTERVIEW_PRD.md` (this file), `manual_test_plan/` (12 scripts + 6 rationale `.md` + thin `README.md` + `_lib.sh` + `00_reset.sh`).
- Per-objection defense notes (`no-lease-and-heartbeat.md`, `no-task-output-column.md`, `coroutine-vs-thread.md`) **stay archived** but are referenced from `interview.md`'s objection table via their `interview/archive/<file>.md` path. They are still load-bearing content; only their *location* shifted.
- `design_decisions.md` is **archived** (its content is digested into `interview.md`'s design section + linked from the objection table when a row needs the long version).

### `interview.md` structure (locked Q1, Q6, Q7, Q8, Q9)

Four sections, in this order, ~240 lines target (no hard cap on the first draft):

1. **Orientation** (~15 lines) — what this document is, who it's for, the skim-then-drill contract, links to the four backing trees (`PRD.md`, `interview/manual_test_plan/`, `interview/archive/`, `tests/`).
2. **How I worked** (~75 lines) — two mermaids (planning timeline + execution feedback-loop graph) with one prose block under each. Planning prose answers *how did you plan*; execution prose answers *how did you execute*, including HITL checkpoints and hooks.
3. **How to verify each requirement** (~60 lines) — canonical 12-row table: `Task | Happy script | Sad script | What it asserts`. One paragraph above explaining the script contract (`[PASS]`/`[FAIL]` + evidence + exit code), the boot prerequisite, and the optional `00_reset.sh`.
4. **Design decisions worth defending** (~90 lines) — 5–8 narrative entries (each: *what we did*, *why*, *production-grade alternative*) followed by a `pushback → defense file` table (~10 rows).

### Shell-script contract (locked Q4, Q5)

- **`interview/manual_test_plan/_lib.sh`** — sourced by every script. Exports: `require_server` (asserts `:3000` is up, exits with help text if not), `post_analysis <clientId> <geoJson>`, `wait_terminal <workflowId> [timeoutSec]` (polls `/status` until `completed`/`failed` or timeout), `dump_workflow <workflowId>` (sqlite snapshot of tasks + results), `format_json` (Python one-liner from existing scripts), `assert_eq <name> <actual> <expected>`, `assert_jq <name> <json> <jqExpr> <expected>`, `assert_http_status <name> <url> <expected>`, `assert_sqlite_eq <name> <query> <expected>`, `summarize` (final `[PASS] §<task> happy/sad path` or `[FAIL] reason: ...` line + exit code).
- **`interview/manual_test_plan/00_reset.sh`** — optional. Kills any process on `:3000`, restarts via `npm start &`, waits for `Server is running`. Used when the reviewer wants a clean DB before a final pass.
- **Per-task scripts (12 total)** — `01_polygon-area.happy.sh`, `01_polygon-area.sad.sh`, `02_report-generation.happy.sh`, `02_report-generation.sad.sh`, `03a_workflow-yaml-dependson.happy.sh`, `03a_workflow-yaml-dependson.sad.sh`, `04_workflow-final-result.happy.sh`, `04_workflow-final-result.sad.sh`, `05_workflow-status.happy.sh`, `05_workflow-status.sad.sh`, `06_workflow-results.happy.sh`, `06_workflow-results.sad.sh`. Each one: source `_lib.sh`, `require_server`, run the test, print `[PASS]`/`[FAIL]` per assertion AND the evidence the assertion is checking, end with `summarize`. Exit code reflects assertion outcome.
- **Sad-path scripts that mutate DB** clean up after themselves via `trap EXIT` (e.g. the `02_report-generation.sad.sh` corrupted-`Result.data` case reverts the surgical `UPDATE`).
- **Per-task rationale `.md`** — six files (one per README requirement). Each explains: *what does this script prove*, *what would change if it broke*, *what to look for in the output*. No curl/sqlite snippets — those live in the script. ~25-40 lines each.

### Workflow narrative content (locked Q6)

- **Mermaid 1 (planning timeline, ~12 nodes)** — left-to-right: `Readme.md` → `to-prd skill (intensive grilling)` → `PRD.md` → `to-issues skill` → `GitHub issues #1..#15` → `CLAUDE.md + Husky hooks` → `TDD per ticket (HITL)` → `iterative hardening (Task 7, follow-ups)` → `manual test plan + scripts`. Edges labeled with the artifact produced.
- **Mermaid 2 (execution feedback-loop, ~10 nodes)** — node graph with cycles: `code edit` → `pre-commit (lint + tsc + vitest related)` ↻ on fail → `commit` → `pre-push (full npm test + lint)` ↻ on fail → `push` → `manual test plan run` ↻ on fail → `PR review (HITL)` ↻ on change-request → `merge`. Annotated: `--no-verify` forbidden; HITL checkpoints marked.

### Design digest content (locked Q7)

The 5–8 narrative entries (final count picked during writing) draw from this candidate pool, ranked by interviewer-grill probability:

1. No lease / heartbeat (the four-layer rebuttal, defended in `interview/archive/no-lease-and-heartbeat.md`)
2. `WORKER_POOL_SIZE=1` default (SQLite shared-connection ceiling, defended in `design_decisions.md` §Task 7)
3. Output stored on `Result`, not `Task` (defended in `interview/archive/no-task-output-column.md`)
4. Coroutines on shared event loop ≠ threads (defended in `interview/archive/coroutine-vs-thread.md`)
5. Fail-fast (CI-pipeline) vs continue-on-error
6. Single-pass transactional workflow creation (UUID v4 minted app-side; no two-pass save)
7. Eager `finalResult` write inside post-task transaction + lazy patch on `/results` read
8. `stepNumber` is the public identifier; internal UUIDs never leak

The objection table (~10 rows) maps interviewer pushback phrasings to the file containing the prepared defense.

## Testing Decisions

This PRD's deliverable is documentation — there is no production code under
test. "Tests" for this work are:

- **Each shell script self-tests its target requirement** — that *is* the test surface. A green per-script `[PASS]` means the README requirement holds end-to-end against the running server.
- **Batch verifier** — `for s in interview/manual_test_plan/0*.sh; do "$s" || echo BROKEN; done` from a clean `00_reset.sh` boot exits 0 across all 12 scripts. This is the single end-to-end "did the documentation stay accurate?" check.
- **`npm test` continues to pass** — no source code is touched; if any test breaks during this work, the doc rebuild has accidentally edited `src/`. CLAUDE.md forbids that.

## Out of Scope

- **Editing anything under `src/`** — the user explicitly excluded it. If a doc claim and the source disagree, the doc is wrong.
- **Editing `tests/`** — same rationale; the test suite is canonical.
- **Editing `Readme.md` or `PRD.md`** — both are referenced from `interview.md` as backing context but not modified.
- **Migrating per-objection notes from `interview/archive/` back to `interview/`** — they stay archived; `interview.md`'s objection table links to them in place.
- **Writing scripts for tasks outside README §1–§6** — Task 0 (test harness), Task 7 (worker-pool default), wave splits (`03b-ii-*`, `03c-*`), and preludes (`pre-7*`) keep their archived `.md` files but get no new shell scripts. They're referenced from the design digest where relevant (Task 7 → `WORKER_POOL_SIZE=1` discussion) but not from the verification table.
- **CI / GitHub Actions wiring** — local hooks and manual test plan scripts are the gate; CI is already documented as out-of-scope in `design_decisions.md` Task 0.
- **Removing files from `interview/archive/`** — preserve everything for audit; the marker `CLAUDE.md` is the only mutation.
- **Diagrams beyond the two mermaids** — no swimlanes, no sequence diagrams, no architecture diagrams in `interview.md`. Anything more lives in linked files.

## Further Notes

- **First-draft length is permitted to exceed 300 lines** (per Q9). Trim during a second pass once we see what's load-bearing. Trim order if needed: prose under mermaids → verification-table sample outputs → design narrative entries. Do **not** trim the objection table or the verification table itself — they're the navigation surface.
- **Implementation order** (suggested): (1) archive existing `interview/` to `interview/archive/` + add CLAUDE.md marker, (2) write `_lib.sh` + `00_reset.sh`, (3) write the 12 scripts (`01.happy → 06.sad`) and run them against a live server to confirm green, (4) write the 6 rationale `.md` files + thin `manual_test_plan/README.md`, (5) write `interview.md` (root) last so it can reference the finished scripts and rationale files by their actual paths.
- **Verification of the verification** — before declaring this work done, run `npm start` in one terminal, then `for s in interview/manual_test_plan/0*.sh; do "$s" || echo BROKEN; done` in another and confirm zero `BROKEN` lines.
