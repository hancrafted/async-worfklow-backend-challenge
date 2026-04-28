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
- After each task is implemented, document in `/interview/manual_test_plan/NN_<task>.md` (one file per task) how to manually test the implemented task step by step. Add the new file to the index in `/interview/manual_test_plan/README.md`.

## Tests

Tests are structured one folder per coding challenge task. E.g. /tests/01-polygon-area/
For each original requirement in the Readme.md there is a exactly one test file.
Test must cover happy path in one describe block and at least one error path in another describe block. The purpose is for the reviewer to make sure and understand that the test serve to fullfil the requirements for each task.

Add inline comments explaining the test, if the test is longer than 10 lines.

Unit tests should place next the the file they are testing. Only integration tests, which proof the requirments of each task are met are in /src/tests.

### Worker-loop tests

Integration tests that exercise the worker loop must use the `drainWorker(...)` helper (manual synchronous drain). Never use `setTimeout` or real timers in worker code paths; never use `vi.useFakeTimers()` to stub the worker sleep.

## Transactions

Any sequence of writes that mutates more than one row, or mutates a row plus persists a related row, must be wrapped in `dataSource.transaction(...)`. Promotion / sweep / lifecycle updates that follow a task's terminal transition belong in the same transaction as the terminal write.

## Quality gates (Husky)

The repo has two layered git hooks. They are unbypassable for both humans and agents (verified — see PRD §Task 0).

- **`pre-commit`** runs fast, staged-file-scoped checks via `lint-staged`: `eslint --fix`, `tsc --noEmit`, and `vitest related --run` on staged `*.ts` files. Doc-only commits are no-ops.
- **`pre-push`** runs the full `npm test` suite + lint.
- **Do not bypass either hook with `--no-verify`.** If a hook reports a real failure, fix it. If it reports an environmental issue (missing dependency, broken hook script), surface it to the parent agent rather than disabling the hook.
- The hooks supplement — they do not replace — the prompt rule above. Run `npm test` during the TDD loop; do not wait for the pre-push hook to discover breakage.

## Commits

- One commit per task. Use conventional commits. In the commit description section add references to which tasks and which user story from the PRD was worked on or completed. The git log serves as a form of memory/documentation.

## Style Guide

### Naming

1. No abbreviations

### export ENUMs intead of magic strings

For errors, states and other enummerables, define and export an ENUM instead of using magic strings.

### Functions

For complex functions use the following pattern

1. Declare varibles at the top of the function
2. Validate input, validation returns null if no error is found, throwing should happen in the main function, not in the validation function
3. Perform main logic
4. Return or cause side effects


EXAMPLE:
```js
enum SomeClassValidationErrors {
    ERROR_RESON_1:"ERROR_RESON_1",
    ERROR_RESON_2:"ERROR_RESON_2",
}

class SomeClass {

    run(input){
        // declare varibles

        // validate
        const validationError = this.validate(input);
        if(validationError){
            throw new Error(validationError);
        }
        // perform main logic

        // retrun or cause side effects

    }

    private validate(input): SomeClassValidationErrors | null{
        const validationError:SomeClassValidationErrors | null = null;
        // verform validtion
        // if(...){validationError = SomeClassValidationErrors.ERROR_RESON_1}
        return validationError;
    }
}
```


