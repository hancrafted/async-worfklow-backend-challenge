# CLAUDE.md

This is a coding challenge for a team lead backend engineer position. 

## Rules

### Pragmatism vs Production grade
Whenenver facing a design decision strike a balance between a pragmatic solution scoped to this coding challenge setup and a production grade solution. Don't optimize to overengineer and impress with a convulted solution.

For Example, this backend is probably following a "Worker Pool" Pattern envisioned to be scaled horizontally while multiple workers running concurrently. However the setup runs only one worker on the main thread in a 5s loop.

### Document "non-production grade" design decisions
Whenever the decision is made to optimize for the scope of this coding challenge, instead of going for production grade, document the decision in the interview/design_decisions.md referencing the coding challenge task.

## Workflow

- Always use the /tdd skill for the implementor agent
- Execute `npm test` frequently and at the very end before commiting the code. Fix the code
- After each task is implemented, document in /interview/manual_test_plan.md how to manually test the implemented task step by step.

## Commits

- One commit per task. Use conventional commits. In the commit description section add references to which tasks and which user story from the PRD was worked on or completed. The git log serves as a form of memory/documentation.   




