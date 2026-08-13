---
name: rvb-verify-linear-task
description: Independently verify one Red VS Blue Linear issue and its PR or local diff against the original contract. Use for QA, acceptance review, regression review, or merge-readiness decisions. The verifier must not have implemented the same change and must cite direct code, behavior, and test evidence rather than the implementer's summary.
---

# RVB Independent Linear Task Verifier

Decide whether one change satisfies its original contract without extending or rewriting the feature.

## Preserve independence

- Do not verify a change implemented in the same context or agent run.
- Start from the original Linear contract, repository rules, diff, and raw evidence.
- Treat PR descriptions, implementation reports, comments, and summaries as claims, not proof.
- Do not edit implementation while acting as verifier. Return findings to the implementer.

If independence cannot be established, report `无法独立验收` and require another AI or human reviewer.

## Build the checklist

Read `AGENTS.md`, the complete Linear contract, related docs/ADRs, the complete diff, and raw test/log/screenshot/replay/state/build evidence. Convert every acceptance item, exclusion, allowed path, and risk requirement into a checklist before judging.

## Inspect in risk order

Check correctness and failure paths; regressions and state contamination; scope violations; behavioral tests; evidence accuracy; docs/save/random/security/rollback duties when relevant; and debug code, secrets, generated files, empty catches, or unrelated edits.

For game logic, verify illegal commands do not mutate state and deterministic behavior holds when required.

## Reproduce proportionately

- Run the smallest relevant test first and inspect outputs/exit codes.
- Expand to static/type checks and affected suites according to risk.
- Perform Electron/Android/manual flows only when required and supported.
- Mark unavailable evidence `无法验证：原因`; never infer success.

Do not update snapshots, dependencies, saves, or implementation files to make verification pass.

## Report findings

Each blocking finding must name the failed contract item, exact file/symbol or behavior, expected and actual result, impact, evidence gap, and smallest required correction. Do not fill the report with style preferences or restate the implementation summary.

## Verdict

Use one verdict:

- `通过`: every required item has adequate evidence.
- `需修改`: one or more requirements, safety checks, or evidence items fail.
- `无法验证`: missing environment or evidence prevents a defensible decision.

Only `通过` may proceed toward Human Approval / Ready to Merge. Never merge or publish.

## Output

```text
Verdict: 通过 | 需修改 | 无法验证
Blocking findings:
Acceptance checklist:
Tests/evidence independently checked:
Scope and risk review:
Non-blocking follow-ups:
Required human checks:
```
