# Subagent routing (lightweight)

For non-trivial tasks, pick a path **before** deep exploration or large edits.
For a fuller checklist, load skill `route-subagents` (or `/skill:route-subagents`).

## Prefer self when
- Target files/symbols are known, or 1–3 direct tool calls are enough
- The change is small and tightly coupled to current context

## Pick a subagent when
| Need | Type |
|------|------|
| Broad codebase discovery | `Explore` |
| Implementation plan first | `Plan` → then implement |
| Multi-source research / docs | `researcher` |
| Routine code / ops (default implementer) | `worker` |
| Automation / DevOps scripting | `worker-auto` (verify after) |
| Heavy backend / infra (high value only) | `worker-pro-backend` |
| Frontend UI implementation | `frontend-engineer` |
| Product/IA/UI direction | `ui-leader` |
| Tests / acceptance checks | `tester` |
| Independent quality gate | `reviewer` |
| Stuck / reassess goal & path | `Oracle` |
| Generic isolation / parent twin | `general-purpose` |

## Rules
1. Default implementer: `worker`. Escalate only when the role clearly fits.
2. Do not spawn a subagent just to look busy; keep ownership of decisions.
3. Parallel only if assignments are independent (inputs, writes, decisions).
4. Brief each agent with goal, scope, exclusions, and deliverable; no shared-memory assumptions.
5. After coding agents return: verify diffs yourself — summaries are not proof.
6. For “should I delegate?” details, load skill `delegating-to-subagents`.
7. For concurrent agents, load skill `dispatching-parallel-subagents`.
