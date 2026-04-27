# CLAUDE.md

This is a coding challenge for a team lead backend engineer position. 

## Rules

### Pragmatism vs Production grade
Whenenver facing a design decision strike a balance between a pragmatic solution scoped to this coding challenge setup and a production grade solution. Don't optimize to overengineer and impress with a convulted solution.

For Example, this backend is probably following a "Worker Pool" Pattern envisioned to be scaled horizontally while multiple workers running concurrently. However the setup runs only one worker on the main thread in a 5s loop.

### Document "non-production grade" design decisions
Whenever the decision is made to optimize for the scope of this coding challenge, instead of going for production grade, document the decision in the interview/design_decisions.md referencing the coding challenge task.

## Workflow

- Always use the /tdd skill for the implementor agent.
- Run `npm test` frequently during the TDD loop and at the very end of every task before declaring it complete. Fix the code on failure — never skip a failing test.
- After each task is implemented, document in `/interview/manual_test_plan.md` how to manually test the implemented task step by step (one section per task).

## Quality gates (Husky)

The repo has two layered git hooks. They are unbypassable for both humans and agents (verified — see PRD §Task 0).

- **`pre-commit`** runs fast, staged-file-scoped checks via `lint-staged`: `eslint --fix`, `tsc --noEmit`, and `vitest related --run` on staged `*.ts` files. Doc-only commits are no-ops.
- **`pre-push`** runs the full `npm test` suite + lint.
- **Do not bypass either hook with `--no-verify`.** If a hook reports a real failure, fix it. If it reports an environmental issue (missing dependency, broken hook script), surface it to the parent agent rather than disabling the hook.
- The hooks supplement — they do not replace — the prompt rule above. Run `npm test` during the TDD loop; do not wait for the pre-push hook to discover breakage.

## Commits

- One commit per task. Use conventional commits. In the commit description section add references to which tasks and which user story from the PRD was worked on or completed. The git log serves as a form of memory/documentation.




