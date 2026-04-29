# Test Folder Refactor — Audit Log

> Mutation-anchored equivalence evidence for the `/tests/` → `/test/` →
> `/tests/` refactor described in `plan/TEST_REFACTOR_PRD.md`. One H2
> section per phase; Tier-A and Tier-B mutation cycles are recorded as
> rows in the per-phase table. Mutated SUT code is never committed — the
> rows below are the only artifact.
>
> Column legend (per `plan/TEST_REFACTOR_PRD.md` §"Audit log format"):
> - **Old file(s)** — path under `/tests/` (and `describe` block, if any)
>   that the mutation targeted.
> - **New file** — path under `/test/` (and `describe` block, if any)
>   that the mutation targeted.
> - **Mutation** — `src/<sut>` location and the change applied.
> - **Old red?** — did the legacy test go red on the mutation?
> - **New red?** — did the new test go red on the mutation?
> - **Reverted clean?** — did `git checkout src/<sut>` restore green on
>   both suites?

## Phase 0

Scaffold only — no mutation cycles. Config diffs, `/test/` skeleton, and
this audit-log file land in the Phase 0 commit.

## Phase 1

## Phase 2

## Phase 3

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 4

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 5

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 6

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 7

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 8

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 9

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|

## Phase 10

Cutover only — archive + rename + config revert. No mutation cycles.
