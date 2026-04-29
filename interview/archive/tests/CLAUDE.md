# Archived test suite — historical evidence

This directory is **historical** evidence of the pre-refactor test suite. It
was the GREEN safety net during the refactor described in
[`plan/TEST_REFACTOR_PRD.md`](../../../plan/TEST_REFACTOR_PRD.md): every new
file under `/tests/` was proved equivalent to its predecessor here via the
mutation-anchored equivalence cycle (Q4), and the audit log at
`/interview/test-refactor-audit.md` is the row-by-row trace. After the
Phase 10 cutover, this folder is excluded from `eslint`, `tsc --noEmit`
(via `tsconfig.eslint.json`), and `vitest` — it is never run, linted, or
typechecked. Do **not** import from this directory and do **not** modify
its files; the live test suite is `/tests/` and the live unit tests sit
next to their `src/` modules.
