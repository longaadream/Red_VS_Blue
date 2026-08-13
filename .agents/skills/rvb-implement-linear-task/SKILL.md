---
name: rvb-implement-linear-task
description: Implement one approved Red VS Blue Linear issue as the AI implementer. Use when asked to develop, fix, document, or prepare a PR for a specific RED issue whose goal, scope, exclusions, acceptance criteria, risk, allowed paths, and tests are defined. Do not use for independent verification of the same change.
---

# RVB Linear Task Implementer

Implement exactly one Linear contract with the smallest defensible change.

## Establish authority

1. Read repository `AGENTS.md` completely.
2. Fetch the named Linear issue and read its full contract.
3. Read only related module docs, ADRs, code, and tests.
4. Inspect the current branch and worktree before writing.

Do not modify files unless the contract defines goal, scope, exclusions, acceptance criteria, risk, allowed paths, tests/evidence, and rollback. If goal, scope, acceptance, or authority is missing or conflicting, stop writing and request clarification.

## Report before implementation

State the outcome, affected modules, risk, tests/evidence, and unresolved questions. Wait only when an ambiguity can materially change the result; otherwise continue with a stated in-scope assumption.

## Work in a controlled branch

- Use an independent branch containing the RED issue number.
- Preserve unrelated and untracked user files.
- Restrict edits to `allowed_paths` and necessary same-PR documentation.
- Do not upgrade dependencies, change rules/numbers, migrate saves, or refactor adjacent code unless explicitly authorized.
- Record out-of-scope findings for separate Linear issues; do not fix them opportunistically.

## Implement and validate

1. Reproduce the problem or establish the baseline before changing behavior.
2. Prefer the smallest root-cause change.
3. Add a failing regression test first when practical.
4. Validate in increasing scope: focused test, static/type checks, affected suite, core flow, then platform smoke test if required.
5. Preserve the command, exit code, logs, seed/state/hash, screenshots, or manual steps required by the contract.

Never report an unrun test as passing. Never hide failures by rerunning until green.

## Self-review and handoff

- Compare the diff with every acceptance item and exclusion.
- Check for unrelated files, secrets, generated artifacts, debug code, and swallowed errors.
- Document tests, failures, known risks, evidence, and rollback.
- Create a PR containing `Fixes RED-N`.
- Move the issue to `In Review` only after the PR exists.

Do not merge, publish, or claim human acceptance.

## Stop conditions

Stop when repository instructions conflict with the contract, required changes exceed allowed paths, High Risk work lacks approved design/rollback, validation requires unauthorized destructive changes, or unrelated worktree changes cannot be preserved.

## Output

```text
Outcome:
Changed:
Acceptance evidence:
Tests (passed / failed / not run):
Known risks:
Out-of-scope follow-ups:
PR / Linear:
Human verification:
```
