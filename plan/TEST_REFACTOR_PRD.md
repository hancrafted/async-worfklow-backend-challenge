# Test Folder Refactor — PRD

> **Status:** Planning artifact for refactoring `/tests/` into a per-task
> structure that mirrors `/interview/manual_test_plan/`. Synthesized from a
> grilling session on 2026-04-29 with seven locked decisions (Q1–Q7).
> Once executed, this PRD is *historical* — the migrated `/tests/` tree and
> the audit log at `/interview/test-refactor-audit.md` are the
> reviewer-facing artifacts.

## Problem Statement

The `/tests/` folder today mixes integration tests, unit tests, helpers, and
architectural-invariant suites under a flat per-task layout that does not
match the project's own `CLAUDE.md` rule (*"unit tests live next to the file
under test; only integration tests live under `/tests/`"*). Specific
inconsistencies:

- `01-polygon-area/` has **two** integration files (one per Requirements
  bullet); `02..06/` each have **one** integration file with happy + error as
  inner describe blocks. The convention is not uniform.
- `*.unit.test.ts` files live inside `/tests/03..06/` instead of next to
  their `src/` modules — eight files in total.
- Cross-task helpers (`drainPool`, `drainWorker`, `seedWorkflow`,
  `mockJobsByType`) live under `tests/03-interdependent-tasks/helpers/` but
  are imported by §2, §3, §3b-ii, §4, §5, §6 — the location is misleading.
- `17-per-worker-datasources/` is a §-less architectural suite (Issue #17,
  not a README §1–§6 requirement) but sits alongside the §-section folders
  with no signal that it's different.
- `smoke.test.ts` sits at the root with no folder.
- `03b-ii-Dependency/` is a §3 sub-wave shelved as a peer of §3 instead of
  absorbed into it.

A reviewer running `ls tests/` cannot tell which folders prove README
requirements and which prove engine-level invariants, and cannot trust the
unit/integration split.

## Solution

Refactor `/tests/` into a structure that mirrors
`/interview/manual_test_plan/`'s convention of *one §-section per folder, one
integration file per §-section with happy + error as inner describes*.
Co-locate unit tests next to their `src/` modules. Separate
non-§ tests into two underscore-prefixed folders (`_architecture/`,
`_setup/`) so the reviewer can tell at a glance which folders prove
requirements and which prove infrastructure.

The refactor is staged in a transitional `/test/` directory (singular) while
`/tests/` (plural) remains the live GREEN reference. Each ported test is
proved equivalent to its predecessor via a **mutation-anchored equivalence
cycle**: a small mutation in the SUT must turn both old and new tests red
before being reverted. After all phases are green, an atomic cutover commit
archives the old suite and renames `/test → /tests`.

## User Stories

1. As a reviewer, I want `ls tests/` to show six §-section folders plus two
   underscore-prefixed infra folders, so that I can immediately tell which
   tests prove README requirements and which prove engine-level invariants.
2. As a reviewer, I want each README §-section to map to exactly one
   integration test file with a `describe("happy", …)` and a
   `describe("error", …)` block, so that I can read one file per requirement
   without hunting for sibling files.
3. As a reviewer, I want unit tests to live next to the `src/` module they
   test, so that I can audit a module's test coverage by reading one
   directory.
4. As a reviewer, I want the cross-cutting `per-worker-datasources` suite
   in a clearly-marked architecture folder, so that I do not misread it as a
   README §-requirement claim.
5. As a reviewer, I want shared test helpers (`drainWorker`, `drainPool`,
   `seedWorkflow`, `mockJobsByType`) to live in a single shared infra
   folder, so that no consumer has to know the helpers historically lived
   under §3.
6. As a reviewer, I want the §3 sub-wave (lifecycle / promotion / fail-fast
   sweep) absorbed into the §3 folder, so that the §3 folder represents the
   complete §3 evidence in one place.
7. As a reviewer, I want every ported test file to have recorded evidence
   that it catches the same regressions as its predecessor, so that I can
   trust the refactor preserved coverage rather than just preserved green.
8. As a reviewer, I want the old `/tests/` suite preserved under
   `/interview/archive/tests/` after the cutover, so that historical context
   is auditable but the current state is unambiguous.
9. As the implementor, I want the old `/tests/` suite to remain runnable
   throughout the refactor, so that I have a continuous GREEN safety net
   while building the new tree.
10. As the implementor, I want a phase plan that produces one conventional
    commit per phase, so that bisecting failures during the refactor lands
    on a small, reviewable diff.
11. As the implementor, I want the cutover to be a single atomic commit
    (archive + rename + config flip), so that the swap is trivially
    reviewable in one screen.
12. As the implementor, I want the audit log format pre-specified, so that
    I do not have to re-derive the recording convention per phase.
13. As the implementor, I want the `vitest.config.ts`, `eslint.config.js`,
    and `tsconfig.eslint.json` change-set spelled out for both Phase 0 and
    Phase 10, so that I do not miss a config knob during the cutover.
14. As the implementor, I want explicit guidance that `package.json` and
    husky configs do **not** change, so that I do not invent ceremony.
15. As a future maintainer, I want `interview/archive/tests/` excluded from
    `eslint`, `tsc`, and `vitest`, so that legacy code does not silently
    block CI when source APIs drift.
16. As a future maintainer, I want the audit log preserved at
    `/interview/test-refactor-audit.md`, so that I can reconstruct
    "did the refactor preserve coverage?" months from now without re-running
    mutation cycles.
17. As a future maintainer, I want shared helpers under `_setup/helpers/`
    rather than `src/test-helpers/`, so that test-only deps (vitest types,
    fixture loaders) never leak into production lint/type configs.

## Implementation Decisions

### Locked decisions (Q1–Q7)

| # | Decision |
|---|---|
| Q1 | One integration file per README §-section with `describe("happy", …)` and `describe("error", …)` blocks. §1 collapses 2 files → 1. Unit tests move next to their `src/` source module. |
| Q2 | Layout: 6 §-section folders (`01-polygon-area/` … `06-workflow-results/`) + `_architecture/` (cross-cutting engine invariants) + `_setup/` (harness scaffolding). 03b-ii absorbed into 03. Unit-side merges: `dependencyValidator.test.ts` (cycle + validation) and `workflowRoutes.test.ts` (dependsOn-translator + lazy-patch). |
| Q3 | Transitional `/test/` (singular) during the build; atomic cutover renames `test → tests` and archives the old suite. Dual-include in `vitest.config.ts` during the transition. |
| Q4 | Mutation-anchored equivalence: ≥1 SUT mutation per `describe` block on Tier-A files; both old and new tests must go red on the same mutation; revert and confirm green. Tiered policy: A (mandatory) for §-section integration ports and merged unit files; B (recommended) for byte-equivalent unit ports and helpers; C (skip) for pure renames. **Mutated SUT code is never committed** — only audit-log evidence. |
| Q4-suppl | Old `/tests/` is **never modified** during the refactor; deletes deferred to the cutover. Old suite is **archived to `/interview/archive/tests/`**, not deleted. |
| Q5 | Shared helpers move to `test/_setup/helpers/` (flat). `helpers.unit.test.ts` → `helpers.test.ts`. All importers rewrite their relative paths. Helpers themselves get one Tier-B mutation cycle each. No splitting of `helpers.test.ts` into per-file tests (out of scope). |
| Q6 | Single PR. 11 commits: phases 0–10 as listed below. Single implementor agent, sequential. Audit log at `/interview/test-refactor-audit.md`. |
| Q7 | No `package.json` script changes. No husky / lint-staged changes. Three configs touched in Phase 0 (`vitest.config.ts`, `tsconfig.eslint.json`, `eslint.config.js`) and reverted + archive-excluded in Phase 10. |

### Target folder layout (post-cutover)

```
tests/                                 # was /test/ during the refactor
├─ _architecture/
│   └─ per-worker-datasources/
│        ├─ overlap.test.ts
│        ├─ production.test.ts
│        └─ fixtures/
├─ _setup/
│   ├─ smoke.test.ts
│   └─ helpers/
│        ├─ drainPool.ts
│        ├─ drainWorker.ts
│        ├─ seedWorkflow.ts
│        ├─ mockJobsByType.ts
│        └─ helpers.test.ts
├─ 01-polygon-area/
│   ├─ polygon-area.test.ts            # merged (was 2 files)
│   └─ fixtures/
├─ 02-report-generation/
│   ├─ report-generation.test.ts
│   └─ fixtures/
├─ 03-interdependent-tasks/            # absorbs 03b-ii
│   ├─ tasks-can-be-chained-through-dependencies.test.ts
│   ├─ lifecycle-claim-bump.test.ts
│   ├─ promotion-envelope.test.ts
│   ├─ fail-fast-sweep.test.ts
│   └─ fixtures/
├─ 04-final-result/
│   ├─ final-result.test.ts
│   └─ fixtures/
├─ 05-workflow-status/
│   └─ workflow-status.test.ts
└─ 06-workflow-results/
     └─ workflow-results.test.ts
```

Co-located unit tests under `src/` (relocated from `tests/03..06/`):

- `src/utils/errorResponse.test.ts`
- `src/workflows/dependencyValidator.test.ts` (cycle + validation merged)
- `src/workflows/WorkflowFactory.test.ts`
- `src/workflows/synthesizeFinalResult.test.ts`
- `src/routes/workflowRoutes.test.ts` (dependsOn-translator + lazy-patch merged)

The `.unit.test.ts` suffix is dropped — once a unit test sits next to the
file under test, the suffix carries no information that the path doesn't
already encode.


### Phase plan (11 commits, single PR)

Each phase ends with `npm test` green, lint green, and the audit log
updated. Conventional-commit subject + body cites this PRD by path
(`Refs: plan/TEST_REFACTOR_PRD.md §Phase N`).

| # | Phase | Tier | Commit subject |
|---|---|---|---|
| 0 | Scaffold `/test/` skeleton; dual-include in `vitest.config.ts`, `tsconfig.eslint.json`, `eslint.config.js`; create `interview/test-refactor-audit.md` skeleton. | — | `chore(test): scaffold /test refactor target` |
| 1 | Copy `helpers/*` + `smoke.test.ts` → `test/_setup/`. Tier-B mutation cycle on each helper. Adjust no consumers yet (consumers in later phases). | B | `chore(test): copy shared helpers + smoke into /test/_setup/` |
| 2 | Copy `17-per-worker-datasources/*` → `test/_architecture/per-worker-datasources/`. Pure rename, no mutation. | C | `chore(test): copy architecture suite into /test/_architecture/` |
| 3 | Port §1: merge two files into `test/01-polygon-area/polygon-area.test.ts` (happy + error describes). Tier-A mutation per describe block. | A | `chore(test): port §1 polygon-area to merged describe-blocks form` |
| 4 | Port §2: copy `report-generation.test.ts`, rewrite helper imports to `_setup/helpers/`. Tier-A mutation. | A | `chore(test): port §2 report-generation` |
| 5 | Port §3 + absorb 03b-ii: chain test + lifecycle / promotion / sweep all under `test/03-interdependent-tasks/`. Tier-A mutation per file. | A | `chore(test): port §3 + absorb 03b-ii dependency sub-wave` |
| 6 | Port §4 final-result. Tier-A mutation. | A | `chore(test): port §4 final-result` |
| 7 | Port §5 workflow-status. Tier-A mutation. | A | `chore(test): port §5 workflow-status` |
| 8 | Port §6 workflow-results. Tier-A mutation. | A | `chore(test): port §6 workflow-results` |
| 9 | Co-locate the 5 unit-test files next to source under `src/`. Two are merges (Tier A), three are byte-equivalent ports (Tier B). | A/B | `chore(test): co-locate unit tests next to source modules` |
| 10 | **Cutover.** Archive old `/tests/`; rename `test → tests`; revert dual-include; add archive excludes to all three configs. Final `npm test`. | — | `chore(test): cutover — archive old /tests, swap /test → /tests` |

### Config diffs (precise)

**Phase 0 — `vitest.config.ts`:**
```diff
- include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
+ include: ["tests/**/*.test.ts", "test/**/*.test.ts", "src/**/*.test.ts"],
```

**Phase 0 — `tsconfig.eslint.json`:**
```diff
- "include": ["src", "tests", "*.config.ts", "*.config.js"],
+ "include": ["src", "tests", "test", "*.config.ts", "*.config.js"],
```

**Phase 0 — `eslint.config.js` (relax-overrides block, ~line 89):**
```diff
- files: ["tests/**", "**/*.test.ts", "**/*.spec.ts"],
+ files: ["tests/**", "test/**", "**/*.test.ts", "**/*.spec.ts"],
```

**Phase 10 — `vitest.config.ts`:**
```diff
- include: ["tests/**/*.test.ts", "test/**/*.test.ts", "src/**/*.test.ts"],
+ include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
+ exclude: ["**/node_modules/**", "**/dist/**", "interview/archive/**"],
```

**Phase 10 — `tsconfig.eslint.json`:**
```diff
- "include": ["src", "tests", "test", "*.config.ts", "*.config.js"],
- "exclude": ["node_modules", "dist"]
+ "include": ["src", "tests", "*.config.ts", "*.config.js"],
+ "exclude": ["node_modules", "dist", "interview/archive"]
```

**Phase 10 — `eslint.config.js`:**
```diff
  ignores: [
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "src/data/**",
    "public/**",
    ".husky/**",
+   "interview/archive/**",
    ...legacySrcFiles,
  ],
  ...
- files: ["tests/**", "test/**", "**/*.test.ts", "**/*.spec.ts"],
+ files: ["tests/**", "**/*.test.ts", "**/*.spec.ts"],
```

### Mutation cycle protocol (Tier A and Tier B)

For each file at the relevant tier:

1. Identify ≥1 mutation site in `src/` per `describe` block in the new
   file (Tier A) or per file (Tier B). Examples: flip a comparator, return
   a constant, delete a guard, off-by-one a loop bound.
2. Apply the mutation.
3. Run `npm test -- <old-path> <new-path>`.
4. **Required outcome:** both old and new go red on the assertions covering
   that behavior. If new stays green where old goes red → coverage gap;
   strengthen the new file before continuing.
5. `git checkout` the mutated `src/` file. Confirm both go green.
6. Record one row in `interview/test-refactor-audit.md` for that mutation.
7. The mutation is **never committed**; the audit-log row is the only
   artifact.

### Audit log format (`interview/test-refactor-audit.md`)

One H2 section per phase. Each Tier-A or Tier-B row in a markdown table:

```
## Phase 3 — §1 polygon-area

| Old file(s) | New file | Mutation | Old red? | New red? | Reverted clean? |
|---|---|---|---|---|---|
| outputs-area-in-square-meters.test.ts | polygon-area.test.ts (`describe("happy")`) | PolygonAreaJob.ts: `area(...)` → `0` | ✅ | ✅ | ✅ |
| handles-invalid-geojson-gracefully.test.ts | polygon-area.test.ts (`describe("error")`) | PolygonAreaJob.ts: catch swallowed → `throw` removed | ✅ | ✅ | ✅ |
```


### Verification ladder (commands the implementor runs per phase)

```bash
# After Phase 0 (dual-include is live):
npm test                # both /tests AND /test must pass; src/ unchanged
npm run lint
npm run typecheck

# Per port phase (3..9), after writing the new file:
npm test -- tests/<old>     # confirm old still green
npm test -- test/<new>      # confirm new green
# then mutation cycle (per-describe-block on Tier A, per-file on Tier B):
#   edit src/<sut>            # apply mutation
#   npm test -- tests/<old> test/<new>   # both must go red
#   git checkout src/<sut>    # revert mutation
#   npm test -- tests/<old> test/<new>   # both green again
# record audit-log row, commit phase.

# After Phase 10 (cutover):
npm test                       # only /tests (renamed) runs; archive ignored
ls interview/archive/tests/    # old suite preserved for audit
```

### Risk & rollback

| Phase | Risk | Rollback |
|---|---|---|
| 0 | Dual-include slows `npm test` by ~2× until cutover. | Acceptable; test suite already <30s. |
| 1–9 | A new file fails its mutation cycle (coverage gap). | Strengthen the new test in the same commit; do not commit until the cycle is clean. |
| 1–9 | A new helper-import path is wrong on the new side. | Mutation cycle catches it (new test goes red on unrelated mutation); fix import, re-run. |
| 10 | Cutover commit includes a stale `/test/` file or misses an archive-exclude. | `git revert` the cutover commit; the dual-include world is restored intact. |
| post-merge | Future PR adds a test under `tests/` that imports from `interview/archive/`. | `eslint` `ignores` block + `tsconfig` `exclude` make this surface as an unresolved-import error during lint, not a runtime failure. |

## Testing Decisions

**What makes a good test in this refactor:** The new tests must exercise
the same external behavior as their predecessors, not the same
implementation details. The mutation-anchored equivalence cycle is the
operationalization of this — if a mutation that breaks a behavior breaks
both old and new, both files are testing the same behavior. Differences
in import paths, fixture loaders, or helper wiring are not behavioral
differences and are explicitly out of scope for the equivalence check.

**Modules tested:** No new behavioral tests are written. Every test in
the new tree corresponds 1:1 (or N:1 for the §1 and the two unit-side
merges) to a test in the old tree. The audit log enforces the mapping.

**Prior art:** The merged-describe-blocks form is already used in
`tests/02..06`. The mutation-anchored equivalence pattern is novel to this
refactor; the PRD is its single specification.

**Tier-A files (mutation cycle mandatory):**

- `test/01-polygon-area/polygon-area.test.ts` — merged from 2 files, ≥2 mutations (1 per describe)
- `test/02-report-generation/report-generation.test.ts` — ≥2 mutations
- `test/03-interdependent-tasks/tasks-can-be-chained-through-dependencies.test.ts` — ≥2 mutations
- `test/03-interdependent-tasks/lifecycle-claim-bump.test.ts` — ≥1 mutation (re-homed, content unchanged)
- `test/03-interdependent-tasks/promotion-envelope.test.ts` — ≥1 mutation
- `test/03-interdependent-tasks/fail-fast-sweep.test.ts` — ≥1 mutation
- `test/04-final-result/final-result.test.ts` — ≥2 mutations
- `test/05-workflow-status/workflow-status.test.ts` — ≥2 mutations
- `test/06-workflow-results/workflow-results.test.ts` — ≥2 mutations
- `src/workflows/dependencyValidator.test.ts` — merged; ≥2 mutations (1 per old source file's coverage)
- `src/routes/workflowRoutes.test.ts` — merged; ≥2 mutations

**Tier-B files (one mutation cycle each, sanity check):**

- `test/_setup/helpers/{drainPool,drainWorker,seedWorkflow,mockJobsByType}.ts`
- `src/utils/errorResponse.test.ts`
- `src/workflows/WorkflowFactory.test.ts`
- `src/workflows/synthesizeFinalResult.test.ts`

**Tier-C files (no mutation, pure rename):**

- `test/_architecture/per-worker-datasources/*.test.ts`
- `test/_setup/smoke.test.ts`

## Out of Scope

1. **Writing new tests** that don't have a predecessor in `/tests/`. Any
   coverage gap discovered during the refactor is reported, not filled.
2. **Splitting `helpers.test.ts`** into per-helper test files. The umbrella
   form is preserved; a future refactor can split.
3. **Rewriting any test logic.** Files are copied (or merged where Q1
   requires); assertion bodies are not edited beyond import-path rewrites.
4. **Editing any `src/` production code permanently.** Mutations are
   transient and never committed.
5. **Reorganizing `interview/manual_test_plan/`.** That folder was
   already rebuilt under `INTERVIEW_PRD.md` and is the *target* convention
   this refactor mirrors; it is not itself touched.
6. **Adding `npm run test:0X` per-task scripts.** `vitest run test/0X-*`
   already works directly.
7. **Adding mutation-testing tooling (Stryker etc.).** The hand-rolled
   per-describe-block discipline is sufficient for this scope.
8. **Renaming `/test` to anything other than `/tests`.** The cutover
   restores the plural `/tests/` to match `CLAUDE.md` and existing repo
   references.
9. **Modifying `package.json`, husky hooks, or `lint-staged` config.**

## Further Notes

- **Branch:** `test-folder-refactor-prd` (already created).
- **Single PR** targeting `main`. Phase commits within the branch.
- **Husky behaviour:** `pre-commit` runs lint-staged on staged `.ts`
  files; `pre-push` runs the full `npm test + lint`. Both auto-pick up
  files under `test/**` once Phase 0 lands. Do not bypass with
  `--no-verify`.
- **`/tdd` skill alignment:** Tier-A phases use the temporary mutation as
  the "red" anchor in a red-green-refactor loop, since the production
  code is already green. The implementor should not attempt outside-in
  TDD on already-shipped behavior.
- **Audit log retention:** `interview/test-refactor-audit.md` is kept
  permanently after the refactor. It is the only persistent evidence
  that coverage was preserved.
- **Cross-link:** This PRD is referenced by every phase commit message
  via `Refs: plan/TEST_REFACTOR_PRD.md §Phase N`. The archive marker at
  `interview/archive/tests/CLAUDE.md` cites this PRD by path.
