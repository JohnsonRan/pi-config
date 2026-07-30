# JohnsonRan Pi Config

Personal extensions and configuration for [Pi](https://pi.dev).

> [!WARNING]
> Pi extensions execute with the current user's full system permissions. Review the source before installing this package.

## Included resources

- `extensions/pi-exa.ts` — Exa web search and page-fetch tools.
- `extensions/third-party-provider.ts` — dynamically discovers and registers models from an OpenAI-compatible third-party endpoint.
- `settings.json` — global Pi preferences, package list, and default model selection.
- `AGENTS.md` — lightweight main-agent routing policy for when to keep work local vs spawn subagents.
- `skills/route-subagents/` — fuller pre-task checklist for classifying work, choosing `subagent_type`(s), briefing, and parallel rules.
- `agents/*.md` — specialized subagent model, reasoning, and role overrides for planning, exploration, implementation, research, review, and testing.

## Install as a Pi package

```powershell
pi install git:github.com/JohnsonRan/pi-config
```

Pi loads the extensions declared in `package.json`. Installed packages run with full system access, so pin a reviewed release when possible:

```powershell
pi install git:github.com/JohnsonRan/pi-config@v0.1.0
```

## Configure the extensions

### Exa tools

`pi-exa.ts` can use Exa's anonymous endpoint. To avoid the shared anonymous rate limit, set an API key:

```powershell
[Environment]::SetEnvironmentVariable("EXA_API_KEY", "your-key", "User")
```

Restart the terminal after changing persistent environment variables.

### Third-party model provider

Required variables:

```powershell
[Environment]::SetEnvironmentVariable("PI_THIRD_PARTY_BASE_URL", "https://your-provider.example/v1", "User")
[Environment]::SetEnvironmentVariable("THIRD_PARTY_API_KEY", "your-key", "User")
```

Common optional variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_THIRD_PARTY_PROVIDER_ID` | Pi provider identifier | `third-party` |
| `PI_THIRD_PARTY_PROVIDER_NAME` | Display name | `Third-party API` |
| `PI_THIRD_PARTY_API` | Pi API adapter | `openai-responses` |
| `PI_THIRD_PARTY_MODELS_FILE` | Metadata override file | `~/.pi/agent/third-party-models.json` |
| `PI_THIRD_PARTY_CONTEXT_WINDOW` | Fallback context window | `128000` |
| `PI_THIRD_PARTY_MAX_TOKENS` | Fallback maximum output | `16384` |
| `PI_THIRD_PARTY_CATALOG` | Set to `off` to disable models.dev metadata | enabled |
| `PI_THIRD_PARTY_CATALOG_FILE` | Local models.dev-compatible catalog | none |
| `PI_THIRD_PARTY_PI_CATALOG` | Set to `off` to disable Pi catalog metadata | enabled |
| `PI_THIRD_PARTY_PI_CATALOG_PROVIDERS` | Comma-separated Pi catalog providers | extension defaults |
| `PI_THIRD_PARTY_PI_CATALOG_FILE` | Local Pi catalog file | none |

Models and their metadata are discovered automatically from the provider's `/models` endpoint and the public catalogs. No model metadata file is included or required. `PI_THIRD_PARTY_MODELS_FILE` remains available only as an optional escape hatch for local overrides. Keep endpoint credentials in environment variables rather than configuration files.

The provider defaults to Pi's `openai-responses` adapter, which sends model requests to `<baseUrl>/responses`. The configured gateway must implement the OpenAI Responses API. For a legacy gateway that only supports Chat Completions, explicitly set:

```powershell
[Environment]::SetEnvironmentVariable("PI_THIRD_PARTY_API", "openai-completions", "User")
```

Restart the terminal and Pi after changing the persistent adapter setting.

### CLIProxyAPI WebSocket transport

The third-party provider includes an opt-in Responses WebSocket transport designed for CLIProxyAPI. It uses the normal CLIProxyAPI bearer key and connects to `<baseUrl>/responses`; unlike Pi's built-in `openai-codex-responses` adapter, it does not require a ChatGPT JWT or add `/codex/responses`.

Select the transport through Pi's global **Settings → Transport** option. The provider follows that setting directly.

| Transport | Behavior |
| --- | --- |
| `sse` | Standard Responses HTTP/SSE transport; the default and most compatible mode. |
| `auto` | Try WebSocket first and fall back to SSE only if the connection fails before the request is sent. Reuses session connections and sends incremental follow-ups when safe. |
| `websocket` | Require WebSocket, reuse the session connection, and send full context on each request. |
| `websocket-cached` | Require WebSocket and use `previous_response_id` plus incremental input when the session state matches. |

CLIProxyAPI must expose WebSocket upgrades on `/v1/responses` (assuming the configured base URL ends in `/v1`). For end-to-end WebSocket transport, the selected CLIProxyAPI Codex auth must also enable `websockets: true`; otherwise the Pi-to-proxy leg can use WebSocket while CLIProxyAPI uses HTTP/SSE upstream.

`auto` is recommended because it preserves SSE fallback for WebSocket handshake, proxy, or endpoint failures before the request is sent. After Pi attempts to send `response.create`, errors are returned instead of replaying the request over SSE, avoiding duplicate generation, billing, tool calls, or other side effects.

## Global setup

`settings.json` is tracked directly because it contains preferences and package declarations, not credentials. Installing this repository at `~/.pi/agent` makes it the active global configuration; when adopting only parts of this repository, merge the desired fields into an existing settings file instead of overwriting it blindly.

The configuration references these separately maintained Pi packages:

```powershell
pi install npm:pi-simplify
pi install npm:@tintinweb/pi-tasks
pi install git:github.com/xz-dev/conventional-commits-skill
pi install npm:context-mode
pi install npm:@tintinweb/pi-subagents
pi install git:github.com/xz-dev/pi-continuity
pi install npm:pi-powerline-footer
pi install git:github.com/xz-dev/human-handoff-skill
pi install git:github.com/xz-dev/SuperAgents-skill
pi install git:github.com/xz-dev/i-read-the-code-skill
pi install npm:@georgebashi/pi-retry
pi install npm:browser-goblin
pi install npm:@llblab/pi-telegram
```

The workflow skill packages add structured human escalation, subagent delegation/review workflows, and evidence-grounded code-review handoffs. `@georgebashi/pi-retry` adds retry support for transient model-provider failures. `browser-goblin` adds browser testing tools/skills; `@llblab/pi-telegram` enables Telegram integration when configured.

The `i-have-adhd` skill is maintained by [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) and is intentionally not redistributed here. Install the upstream version globally for Pi:

```powershell
npx skills add ayghri/i-have-adhd -a pi -y -g
```

Update it from upstream with:

```powershell
npx skills update i-have-adhd -g
```

Do not blindly overwrite an existing `settings.json`; merge the desired fields instead.

### Subagent routing

Main-agent routing is intentionally lightweight by default:

| Resource | Role |
| --- | --- |
| `AGENTS.md` | Always-on short policy: prefer self for small known work; map common needs to agent types; avoid busywork delegation |
| `skills/route-subagents/` | On-demand checklist for non-trivial tasks: classify → keep local vs delegate → choose type(s) → brief → parallel rules → verify |
| SuperAgents skills | Deeper workflows already installed via packages: `delegating-to-subagents`, `dispatching-parallel-subagents`, `reviewing-subagent-work`, etc. |

**Graded process (not a forced full plan every turn):**

1. **Trivial** — do it locally; no routing ceremony.
2. **Medium / multi-step** — decide before deep exploration or large edits; for a fuller checklist load `route-subagents` or run `/skill:route-subagents`.
3. **Complex / multi-domain** — split into bounded assignments, choose types, and only parallelize when independence is clear.

Default implementer is `worker`. Escalate to specialist agents only when the role clearly fits. After coding agents return, verify diffs yourself — summaries are not proof.

Pi loads `AGENTS.md` as a context file from `~/.pi/agent/AGENTS.md` (and project/ancestor `AGENTS.md` files). Skills under `skills/` are discovered globally; force-load with `/skill:route-subagents` when needed. Run `/reload` or start a new session after changing either resource.

### Specialized subagents

The files under `agents/` configure global specialized agents used by `@tintinweb/pi-subagents`:

| Agent | Model | Thinking | Role |
| --- | --- | --- | --- |
| `Explore` | `third-party/gpt-5.6-terra` | `high` | Codebase exploration |
| `Plan` | `third-party/gpt-5.6-sol` | `max` | Planning; plans should be reviewed before heavy implementation |
| `frontend-engineer` | `third-party/gemini-3.6-flash-high` | model default | Frontend implementation |
| `general-purpose` | `third-party/grok-4.5` | `medium` | Generic isolation / parent-twin style tasks |
| `Oracle` | `third-party/gpt-5.6-sol` | `max` | Reflection, course correction, wasted-effort checks |
| `researcher` | `third-party/grok-4.5` | `high` | Multi-source research / docs |
| `reviewer` | `third-party/gpt-5.6-sol` | `xhigh` | Independent quality gate |
| `tester` | `third-party/grok-build-0.1` | `high` | Test design, automation, and acceptance verification |
| `ui-leader` | `third-party/gemini-3.6-flash-high` | model default | Product/IA/UI direction |
| `worker-auto` | `third-party/grok-composer-2.5-fast` | model default | Automation and DevOps scripting (verify after) |
| `worker-pro-backend` | `third-party/grok-build-0.1` | `high` | Heavy backend/infra when value justifies wait cost |
| `worker` | `third-party/gpt-5.6-terra` | `medium` | Default fast routine implementation |

Suggested need → type mapping lives in `AGENTS.md` and `skills/route-subagents/SKILL.md`.

Pi discovers these files globally at `~/.pi/agent/agents/`. A project-specific file at `<project>/.pi/agents/<agent-name>.md` takes precedence over its global counterpart.

The configured models must be available in Pi's model registry. Verify a model with, for example:

```powershell
pi --list-models gpt-5.6-sol
```

Restart the Pi session after adding or changing an agent definition.

## Development

Its allowlist-style `.gitignore` excludes Pi credentials, sessions, caches, installed packages, trust decisions, and generated model data.

After changing a resource:

```powershell
git status
git diff
git add settings.json extensions README.md AGENTS.md skills agents
git commit -m "feat: describe the change"
git push
```

Inside Pi, run `/reload` after editing extensions, skills, prompts, themes, or context files such as `AGENTS.md`.

## Security

Never commit:

- `auth.json` or provider credentials
- `sessions/` or exported conversations
- `trust.json`
- `.env` files or literal API keys
- `cache/`, `npm/`, `git/`, `.pi/`, or generated model stores

Configuration files committed to this repository must not contain endpoint credentials. Provider API keys and private base URLs belong in environment variables.

## License

MIT — see [LICENSE](LICENSE).
