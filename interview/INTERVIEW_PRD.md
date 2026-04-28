# Interview Documentation Polish — PRD

> **Status:** Planning artifact for the rebuild of `interview/` and the new
> `interview.md` at repo root. Synthesized from a 9-round grill on
> 2026-04-28; rebased after `main` advanced through Issues #17 and #22 the
> same day. Locked decisions live in `## Implementation Decisions` below.
> Once the work is done, this PRD is *historical* — `interview.md` is the
> reviewer-facing entry point.

## Rebase notes (post-grill)

`main` moved forward after the grill closed; this PRD reflects the merged
state. Two changes shift the design narrative:

- **Issue #17 — per-worker DataSources + WAL.** `DEFAULT_WORKER_POOL_SIZE`
  is back to **3** (was pinned at 1 against a shared SQLite connection).
  The "we shipped default=1" interview talking point is now a *journey*:
  ship pragmatic ceiling → identify substrate fix → restore production
  default. Iterative hardening, in the file. Archived note for #17 lives at
  `interview/manual_test_plan/17a_per-worker-datasources-production.md` and
  is referenced from the design digest.
- **Issue #22 — strict `400 WORKFLOW_FAILED` on `/results`.** The lenient
  policy (return `200` for any terminal workflow) was replaced by a strict
  reading of README §6. `failed` now returns `400 { error:
  "WORKFLOW_FAILED" }`; `completed` keeps `200`. Failure detail still
  surfaces via `/status`. The §06 sad-path script asserts the new shape.

## Round 10 grill — locked decisions (2026-04-28)

A 10-question Round-10 grill on 2026-04-28 closed every remaining open
question on the interview-docs rebuild scope. Decisions are folded into the
PRD below as targeted amendments (no rewrite). The canonical reference for
each decision is this table:

| # | Decision |
|---|---|
| Q1.5 | Swap `src/workflows/example_workflow.yml` → 24-step concurrent DAG (mirrors current `complex_workflow.yml`) **with lane-report dep fix on steps 21/22/23**: step 21 `dependsOn: [2, 5]`; step 22 `dependsOn: [3, 6]`; step 23 `dependsOn: [4, 7]`. Step 24 keeps `dependsOn: [21, 22, 23]`. Delete `complex_workflow.yml` after the swap. |
| Q1 (subsumed) | Scripts use shipped-chain inspection. No script edits any file under `src/`. No script restarts the server. |
| Q2 | `*.sad.sh` may bundle multiple error-path assertions. One `[PASS]`/`[FAIL]` line per assertion. Script exits non-zero if any assertion fails. |
| Q3 | **§03a has no sad-path script.** Total = **11 scripts** (6 happy + 5 sad). Verification table shows "—" for §03a sad with footnote pointing to `tests/03a-workflow-yaml-dependson/`. |
| Q4 | Underscore-only filenames: `NN_<slug>_happy.sh`, `NN_<slug>_sad.sh`. One rationale `NN_<slug>.md` per requirement covering both paths. |
| Q5 | Move `PRD.md` → `/plan/PRD.md` and `interview/INTERVIEW_PRD.md` → `/plan/INTERVIEW_PRD.md`. `interview.md` references both via `./plan/<file>`. Implementor `grep`s for `PRD.md` references repo-wide and updates non-archived ones. |
| Q6 | Two-terminal pattern. No `00_reset.sh`, no PID/log files. `_lib.sh::require_server` prints actionable error if `:3000` unreachable. |
| Q7 | WorkflowId-scoped hermeticity. Every script captures its own `$WORKFLOW_ID`; assertions filter by it; sad scripts revert mutations via `trap EXIT`; no global counts. |
| Q8 | Pin safe Mermaid subset AND verify both diagrams render on github.com after push. Implementor's "done" check includes the github.com render verification. |
| Q9 | Tiered digest rule: Tier A always (5) = #1, #2, #3, #4, #9. Tier B picked (1–3) from {#5, #6, #7, #8} by length budget. Total 6–8 entries. |
| Q10 | Single PR. Phase commits within `polish-interview-docs`, conventional-commit format. |

**PRD scope amendments**

Original Out-of-Scope said *"editing anything under `src/`"*. Two carve-outs are now explicit, plus a `PRD.md` path move:

1. **`src/workflows/example_workflow.yml`** — swapped to the 24-step concurrent DAG with the lane-report dep fix (Q1.5).
2. **`src/workflows/complex_workflow.yml`** — deleted post-swap (Q1.5).
3. **`PRD.md` move to `/plan/PRD.md`** — path-only change, no content edit (Q5).

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
2. As an interviewer, I want to verify each README requirement (§1–§6) by running one happy script per requirement (and one sad script per requirement except §03a — see Round-10 Q3), so that I can confirm the system works without writing curl commands myself.
3. As an interviewer, I want every script to print observable evidence AND a `[PASS]`/`[FAIL]` verdict line, so that I can both audit *what* was checked and skim *whether* it passed.
4. As an interviewer, I want scripts to exit non-zero on failure, so that I can run all 11 in a batch loop and get a one-glance smoke verdict (one happy + one sad each, minus §03a sad).
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
- **Round-10 amendment (Q5):** `INTERVIEW_PRD.md` and `PRD.md` are moved to `/plan/` (i.e. `/plan/INTERVIEW_PRD.md` and `/plan/PRD.md`). The implementor `grep`s for `PRD.md` references repo-wide and updates non-archived ones.

### `interview.md` structure (locked Q1, Q6, Q7, Q8, Q9)

Four sections, in this order, ~240 lines target (no hard cap on the first draft):

1. **Orientation** (~15 lines) — what this document is, who it's for, the skim-then-drill contract, links to the four backing trees (`PRD.md`, `interview/manual_test_plan/`, `interview/archive/`, `tests/`).
2. **How I worked** (~75 lines) — two mermaids (planning timeline + execution feedback-loop graph) with one prose block under each. Planning prose answers *how did you plan*; execution prose answers *how did you execute*, including HITL checkpoints and hooks.
3. **How to verify each requirement** (~60 lines) — canonical 12-row table: `Task | Happy script | Sad script | What it asserts`. One paragraph above explaining the script contract (`[PASS]`/`[FAIL]` + evidence + exit code), the boot prerequisite, and the optional `00_reset.sh`.
4. **Design decisions worth defending** (~90 lines) — 5–8 narrative entries (each: *what we did*, *why*, *production-grade alternative*) followed by a `pushback → defense file` table (~10 rows).
   - **Round-10 amendment (Q9):** Tier A (always include) = entries #1, #2, #3, #4, #9. Tier B (1–3 picked by length budget) from {#5, #6, #7, #8}. Total 6–8 entries.

### Shell-script contract (locked Q4, Q5)

- **`interview/manual_test_plan/_lib.sh`** — sourced by every script. Exports: `require_server` (asserts `:3000` is up, exits with help text if not), `post_analysis <clientId> <geoJson>`, `wait_terminal <workflowId> [timeoutSec]` (polls `/status` until `completed`/`failed` or timeout), `dump_workflow <workflowId>` (sqlite snapshot of tasks + results), `format_json` (Python one-liner from existing scripts), `assert_eq <name> <actual> <expected>`, `assert_jq <name> <json> <jqExpr> <expected>`, `assert_http_status <name> <url> <expected>`, `assert_sqlite_eq <name> <query> <expected>`, `summarize` (final `[PASS] §<task> happy/sad path` or `[FAIL] reason: ...` line + exit code).
- **`interview/manual_test_plan/00_reset.sh`** — optional. Kills any process on `:3000`, restarts via `npm start &`, waits for `Server is running`. Used when the reviewer wants a clean DB before a final pass.
- **Per-task scripts (11 total, Round-10 Q3 + Q4)** — underscore-only naming `NN_<slug>_happy.sh` and `NN_<slug>_sad.sh`. §03a ships only `_happy.sh` (its sad-path coverage lives in `tests/03a-workflow-yaml-dependson/`). Full list: `01_polygon-area_happy.sh`, `01_polygon-area_sad.sh`, `02_report-generation_happy.sh`, `02_report-generation_sad.sh`, `03a_workflow-yaml-dependson_happy.sh`, `04_workflow-final-result_happy.sh`, `04_workflow-final-result_sad.sh`, `05_workflow-status_happy.sh`, `05_workflow-status_sad.sh`, `06_workflow-results_happy.sh`, `06_workflow-results_sad.sh`. Each one: source `_lib.sh`, `require_server`, run the test, print `[PASS]`/`[FAIL]` per assertion AND the evidence the assertion is checking, end with `summarize`. Exit code reflects assertion outcome.
- **Round-10 amendment (Q2):** *Sad scripts may bundle multiple error-path assertions when the requirement has more than one sad branch. Each assertion is a separate `[PASS]`/`[FAIL]` line; the script exits non-zero if any fails.*
- **Round-10 amendment (Q6):** *Two-terminal pattern: reviewer runs `npm start` in one terminal and the batch loop in another. No `00_reset.sh` ships; no script manages server lifecycle. `_lib.sh::require_server` prints an actionable error if `:3000` is unreachable.*
- **Round-10 amendment (Q7):** *WorkflowId-scoped hermeticity: every script captures its own `$WORKFLOW_ID`; all assertions filter by `WHERE workflowId='$WORKFLOW_ID'`; no script reads global counts; sad scripts that mutate revert via `trap EXIT`.*
- **Sad-path scripts that mutate DB** clean up after themselves via `trap EXIT` (e.g. the `02_report-generation.sad.sh` corrupted-`Result.data` case reverts the surgical `UPDATE`).
- **`06_workflow-results.sad.sh`** asserts the post-#22 contract: a workflow whose first step fails terminates as `failed`, and `GET /workflow/:id/results` returns **`400 { error: "WORKFLOW_FAILED" }`** (not `200`). The happy script asserts `200 { workflowId, status: "completed", finalResult }`.
- **Per-task rationale `.md`** — six files (one per README requirement). Each explains: *what does this script prove*, *what would change if it broke*, *what to look for in the output*. No curl/sqlite snippets — those live in the script. ~25-40 lines each.

### Workflow narrative content (locked Q6)

- **Mermaid 1 (planning timeline, ~12 nodes)** — left-to-right: `Readme.md` → `to-prd skill (intensive grilling)` → `PRD.md` → `to-issues skill` → `GitHub issues #1..#22` → `CLAUDE.md + Husky hooks` → `TDD per ticket (HITL)` → `iterative hardening (Task 7 → Issue #17 substrate fix; #22 strict /results)` → `manual test plan + scripts`. Edges labeled with the artifact produced.
- **Mermaid 2 (execution feedback-loop, ~10 nodes)** — node graph with cycles: `code edit` → `pre-commit (lint + tsc + vitest related)` ↻ on fail → `commit` → `pre-push (full npm test + lint)` ↻ on fail → `push` → `manual test plan run` ↻ on fail → `PR review (HITL)` ↻ on change-request → `merge`. Annotated: `--no-verify` forbidden; HITL checkpoints marked.
- **Round-10 amendment (Q8):** Mermaid syntax is constrained to a github.com-safe subset — `flowchart LR` for the timeline, `flowchart TD` for the feedback-loop graph; node labels `A[Plain ASCII]`; edge labels `-->|short|`; no `subgraph` styling, `classDef`, `style`, `linkStyle`, or `themeVariables`; ≤15 nodes per diagram. After pushing the implementation branch, the implementor opens `interview.md` on github.com and visually confirms both diagrams render.

### Design digest content (locked Q7)

The 5–8 narrative entries (final count picked during writing) draw from this candidate pool, ranked by interviewer-grill probability:

1. No lease / heartbeat (the four-layer rebuttal, defended in `interview/archive/no-lease-and-heartbeat.md`)
2. **Worker pool default journey: shipped 1 → fixed substrate via Issue #17 → restored 3.** Per-worker `DataSource` instances + WAL mode replaced the shared-connection ceiling (defended in `interview/archive/design_decisions.md` §Task 7 + §Issue #17, plus `interview/manual_test_plan/17a_per-worker-datasources-production.md`). The talking point is *iterative hardening*, not the pin itself.
3. Output stored on `Result`, not `Task` (defended in `interview/archive/no-task-output-column.md`)
4. Coroutines on shared event loop ≠ threads (defended in `interview/archive/coroutine-vs-thread.md`)
5. Fail-fast (CI-pipeline) vs continue-on-error — sweep on `Failed`, promotion on `Completed`, in-progress siblings run to completion (no cancellation interface)
6. Single-pass transactional workflow creation (UUID v4 minted app-side; no two-pass save)
7. Eager `finalResult` write inside post-task transaction + lazy patch on `/results` read
8. `stepNumber` is the public identifier; internal UUIDs never leak
9. **Strict `400 WORKFLOW_FAILED` on `/results` (Issue #22).** Originally lenient (`200` for any terminal); reverted to README-literal after weighing caller branching vs. HTTP-status purity. Failure detail surfaces on `/status` instead.

The objection table (~10 rows) maps interviewer pushback phrasings to the file containing the prepared defense.

## Testing Decisions

This PRD's deliverable is documentation — there is no production code under
test. "Tests" for this work are:

- **Each shell script self-tests its target requirement** — that *is* the test surface. A green per-script `[PASS]` means the README requirement holds end-to-end against the running server.
- **Batch verifier** — `for s in interview/manual_test_plan/0*.sh; do "$s" || echo BROKEN; done` from a clean `00_reset.sh` boot exits 0 across all 12 scripts. This is the single end-to-end "did the documentation stay accurate?" check.
- **`npm test` continues to pass** — no source code is touched; if any test breaks during this work, the doc rebuild has accidentally edited `src/`. CLAUDE.md forbids that.

## Out of Scope

- **Editing anything under `src/`** — except, per Round-10 Q1.5: (a) `src/workflows/example_workflow.yml` is swapped to the 24-step concurrent DAG with lane-report dep fix on steps 21/22/23 (each lane report depends on `[polygonArea, analysis]`); (b) `src/workflows/complex_workflow.yml` is deleted post-swap. No other `src/` edits.
- **Editing `tests/`** — same rationale; the test suite is canonical.
- **Editing `Readme.md` or `PRD.md`** — both are referenced from `interview.md` as backing context but not modified. **Round-10 amendment (Q5):** `PRD.md` is moved to `/plan/PRD.md` (path-only change, no content edit).
- **Migrating per-objection notes from `interview/archive/` back to `interview/`** — they stay archived; `interview.md`'s objection table links to them in place.
- **Writing scripts for tasks outside README §1–§6** — Task 0 (test harness), Task 7 (worker-pool default journey), wave splits (`03b-ii-*`, `03c-*`), preludes (`pre-7*`), and Issue #17 sub-waves (`17a/17b/17c`) keep their archived `.md` files but get no new shell scripts. They're referenced from the design digest where relevant (Task 7 + Issue #17 → "default pool size journey" entry) but not from the verification table.
- **CI / GitHub Actions wiring** — local hooks and manual test plan scripts are the gate; CI is already documented as out-of-scope in `design_decisions.md` Task 0.
- **Removing files from `interview/archive/`** — preserve everything for audit; the marker `CLAUDE.md` is the only mutation.
- **Diagrams beyond the two mermaids** — no swimlanes, no sequence diagrams, no architecture diagrams in `interview.md`. Anything more lives in linked files.

## Further Notes

- **First-draft length is permitted to exceed 300 lines** (per Q9). Trim during a second pass once we see what's load-bearing. Trim order if needed: prose under mermaids → verification-table sample outputs → design narrative entries. Do **not** trim the objection table or the verification table itself — they're the navigation surface.
- **Implementation order (Round-10 phase ordering)**:
  1. Archive existing `interview/` → `interview/archive/`; move `PRD.md` → `/plan/PRD.md` and `interview/INTERVIEW_PRD.md` → `/plan/INTERVIEW_PRD.md`; add `interview/archive/CLAUDE.md` marker.
  2. Swap `src/workflows/example_workflow.yml` to the 24-step concurrent DAG with the lane-report dep fix; delete `src/workflows/complex_workflow.yml`; run `npm test` to confirm no fallout.
  3. Write `_lib.sh` + the 11 scripts; run them against a live server (two-terminal) to confirm green.
  4. Write the 6 rationale `.md` files + thin `manual_test_plan/README.md`.
  5. Write `interview.md` at repo root last; push branch; verify both Mermaid diagrams render on github.com.
- **Verification of the verification** — before declaring this work done, run `npm start` in one terminal, then `for s in interview/manual_test_plan/0*.sh; do "$s" || echo BROKEN; done` in another and confirm zero `BROKEN` lines.
