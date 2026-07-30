---
name: route-subagents
description: Use before multi-step or non-trivial work to decide whether to keep work local or spawn subagents, and which subagent_type(s) to use.
---

# Route Subagents

Run this **before** deep exploration, large edits, or spawning agents.

## 1. Classify the task

Answer briefly (internally or in a short plan):

1. **Goal** — one sentence
2. **Known targets?** — exact paths/symbols yes/no
3. **Size** — trivial / medium / large
4. **Domains** — code, research, UI, backend, tests, ops, planning, stuck

## 2. Keep local vs delegate

**Keep local (no Agent tool)** when:

- targets are known and 1–3 direct tools suffice
- change is small and tightly coupled to current context
- you need to make the core decision yourself

**Delegate** only when at least one holds:

- broad discovery would pollute parent context
- real parallel progress is possible
- independent verification/specialist role is valuable

If unsure whether delegation is worth it, also load skill `delegating-to-subagents`.

## 3. Choose type(s)

| Need | Type |
|------|------|
| Broad codebase discovery | `Explore` |
| Implementation plan first | `Plan` → then implement |
| Multi-source research / docs | `researcher` |
| Routine code / ops (default) | `worker` |
| Automation / DevOps scripting | `worker-auto` (verify after) |
| Heavy backend / infra (high value only) | `worker-pro-backend` |
| Frontend UI implementation | `frontend-engineer` |
| Product/IA/UI direction | `ui-leader` |
| Tests / acceptance | `tester` |
| Independent quality gate | `reviewer` |
| Stuck / reassess path | `Oracle` |
| Generic isolation / parent twin | `general-purpose` |

Defaults:

- implementer → `worker`
- escalate only when the specialist clearly fits
- do not spawn agents just to look active

## 4. Shape each assignment

For every subagent call, the prompt must include:

- objective (one observable outcome)
- scope + exclusions
- known facts / paths / constraints
- deliverable + how you will verify
- stop/escalate conditions

Never assume shared memory. Never dump credentials.

## 5. Parallel only if independent

Before concurrent `Agent` calls, confirm independence of:

- inputs, write surfaces, decisions, shared resources, ordering

If not independent: sequence. If yes and ≥2 assignments: load skill `dispatching-parallel-subagents`, then dispatch in one message with `run_in_background: true`.

## 6. After return

- coding agents → inspect actual diffs
- research agents → synthesize yourself; do not re-delegate understanding
- quality agents → treat findings as evidence, not automatic truth

## Minimal output before acting

For non-trivial tasks, state in 2–5 lines then act:

```text
Route: self | <type>[, <type>...]
Why: <one line>
Parallel: no | yes (<independence note>)
Next: <first action>
```
