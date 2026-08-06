# JohnsonRan Pi Config

Personal extensions and configuration for [Pi](https://pi.dev).

> [!WARNING]
> Pi extensions execute with the current user's full system permissions. Review the source before installing this package.

## Included resources

- `extensions/pi-web.ts` — multi-provider web search and page-fetch tools with automatic Firecrawl → Tavily → Exa fallback.
- `extensions/third-party-provider.ts` — dynamically discovers and registers models from an OpenAI-compatible third-party endpoint.
- `settings.json` — global Pi preferences, package list, and default model selection.
- `pi-retry.json` — retryable provider-error patterns for the `pi-retry` extension.
- `pi-continue-watchdog.json` — idle delay, retry limit, and continuation prompts for the `pi-continue-watchdog` extension.
- `pi-notify.json` — trusted notification actions for questions, completed work, and continuation-watchdog outcomes.
- `pi-notify-bark.cjs` — local Bark push companion with automatic withdrawal of retractable notifications after interactive input.
- `AGENTS.md` — lightweight main-agent routing policy for when to keep work local vs spawn subagents.
- `skills/route-subagents/` — fuller pre-task checklist for classifying work, choosing `subagent_type`(s), briefing, and parallel rules.
- `agents/*.md` — specialized subagent definitions with model/reasoning overrides, inherited-context rules, default artifacts, and focused prompts for planning, implementation, research, review, and testing.

## Install as a Pi package

```powershell
pi install git:github.com/JohnsonRan/pi-config
```

Pi loads the extensions declared in `package.json`. Installed packages run with full system access, so pin a reviewed release when possible:

```powershell
pi install git:github.com/JohnsonRan/pi-config@v0.1.0
```

## Configure the extensions

### Web search and fetch tools

The extension registers two provider-neutral tools:

- `web_search` — search the web
- `web_fetch` — fetch known webpages as clean markdown

Requests use this provider order:

1. **Firecrawl** when `FIRECRAWL_API_KEY` is set
2. **Tavily** when `TAVILY_API_KEY` is set
3. **Exa** as the final fallback; Exa's anonymous endpoint works without a key

Set any provider keys you want to use:

```powershell
[Environment]::SetEnvironmentVariable("FIRECRAWL_API_KEY", "fc-your-key", "User")
[Environment]::SetEnvironmentVariable("TAVILY_API_KEY", "tvly-your-key", "User")
[Environment]::SetEnvironmentVariable("EXA_API_KEY", "your-exa-key", "User")
```

A provider is skipped when its key is absent. The extension automatically moves to the next provider for exhausted credits/plan limits, rate limits, invalid or unusable credentials, upstream `5xx` responses, timeouts, and network failures. Providers that return persistent quota, plan, or credential failures remain skipped for the rest of the current extension load, so later calls start with the next provider; run `/reload` after fixing a key or adding credits. Request validation failures such as malformed URLs or invalid parameters are reported immediately rather than hidden by fallback.

Firecrawl and Tavily require API keys. `EXA_API_KEY` is optional, but setting it avoids Exa's shared anonymous rate limit. Restart the terminal after changing persistent environment variables.

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
pi install npm:context-mode
pi install git:github.com/xz-dev/pi-continuity
pi install npm:pi-powerline-footer
pi install git:github.com/xz-dev/human-handoff-skill
pi install git:github.com/xz-dev/SuperAgents-skill
pi install git:github.com/xz-dev/i-read-the-code-skill
pi install npm:browser-goblin
pi install git:github.com/xz-dev/pi-tasks
pi install git:github.com/xz-dev/pi-hermes-memory
pi install git:github.com/xz-dev/pi-continue-watchdog
pi install git:github.com/xz-dev/conventional-commits-skill
pi install git:github.com/xz-dev/pi-subagents
pi install git:github.com/xz-dev/pi-retry
pi install git:github.com/xz-dev/pi-notify
```

The workflow skill packages add structured human escalation, subagent delegation/review workflows, evidence-grounded code-review handoffs, and persistent Hermes memory. The GitHub-hosted `pi-subagents`, `pi-tasks`, and `pi-retry` packages replace the previous subagent and retry package references. `pi-retry.json` lists provider errors that may be retried. `pi-continue-watchdog` can resume unfinished work after an idle delay, using the tracked `pi-continue-watchdog.json` limits and prompts. `pi-notify` dispatches the tracked notification actions described below. `browser-goblin` adds browser testing tools/skills.

The `i-have-adhd` skill is maintained by [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) and is intentionally not redistributed here. Install the upstream version globally for Pi:

```powershell
npx skills add ayghri/i-have-adhd -a pi -y -g
```

Update it from upstream with:

```powershell
npx skills update i-have-adhd -g
```

Do not blindly overwrite an existing `settings.json`; merge the desired fields instead.

### Notifications and Bark

`pi-notify.json` publishes OSC notifications and Bark pushes for:

- tools that require user input;
- successful agent completion and explicit `agent-notify` messages;
- continuation-watchdog exhaustion or decision failures.

Bark delivery is handled by `pi-notify-bark.cjs`. Create an untracked `~/.pi/agent/pi-notify-bark.secret` containing one HTTP(S) Bark push URL whose final path segment is the device key, for example:

```text
https://api.day.app/your-device-key
```

The helper derives the server's `/push` JSON endpoint from that URL, sends notifications in the `pi-notify` group, and never stores the device key in tracked configuration. Notifications that ask for input or announce completion use a generated Bark message ID; the helper deletes them when the next interactive input arrives. Non-interactive or programmatic input does not withdraw them.

The tracked actions currently load the CommonJS helper relative to `C:/Users/JohnsonRan/.pi/agent/pi-notify.json` with Node's `createRequire`. This avoids dynamic `import()` because pi-notify evaluates trusted `js:` actions through `Function`, where an import callback may be unavailable. Adjust the `createRequire` file URLs in `pi-notify.json` when using a different Pi configuration path. Keep `pi-notify-bark.secret` local and never commit it.

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

Default implementer is `worker`. Use the built-in `scout` for codebase exploration and `delegate` for generic isolated work; `settings.json` overrides both to `third-party/gpt-5.6-luna` with `xhigh` thinking and a `third-party/deepseek-v4-flash:max` fallback. Escalate to specialist agents only when the role clearly fits. After coding agents return, verify diffs yourself — summaries are not proof.

Pi loads `AGENTS.md` as a context file from `~/.pi/agent/AGENTS.md` (and project/ancestor `AGENTS.md` files). Skills under `skills/` are discovered globally; force-load with `/skill:route-subagents` when needed. Run `/reload` or start a new session after changing either resource.

### Specialized subagents

The files under `agents/` configure global specialized agents used by `xz-dev/pi-subagents`:

| Agent | Model | Thinking | Role |
| --- | --- | --- | --- |
| `scout` (built-in override) | `third-party/gpt-5.6-luna` | `xhigh` | Fast codebase exploration and compressed context handoff |
| `delegate` (built-in override) | `third-party/gpt-5.6-luna` | `xhigh` | Generic isolated work with no default reads |
| `Plan` | `third-party/kmc/k3` | `high` | Read-only planning that writes `plan.md` from inherited context and research |
| `code-merge-reviewer` | `third-party/gpt-5.6-luna` | `max` | Final pre-push/merge necessity review |
| `frontend-engineer` | `third-party/kmc/k3` | `max` | Production frontend implementation with browser-backed verification |
| `Oracle` (`oracle`) | `third-party/gpt-5.6-sol` | `max` | Project/plan reflection and course correction, not routine implementation |
| `researcher` | `third-party/gpt-5.6-terra` | `high` | Source-backed multi-provider research that writes `research.md` when requested |
| `reviewer` | `third-party/gpt-5.6-sol` | `medium` | Focused quality gate for an individual implementation step |
| `reviewer-final` | `third-party/gpt-5.6-sol` | `xhigh` | Final rigorous quality gate after implementation and verification |
| `tester` | `third-party/gpt-5.6-sol` | `medium` | Test design, automation, manual acceptance, and verification |
| `ui-leader` | `third-party/kmc/k3` | `max` | Product/IA/UI direction, including optional visual mockups as implementation references |
| `worker-auto` | `third-party/grok-4.5` | `high` | Fast automation work (verify independently afterward) |
| `worker-pro-backend` | `third-party/gpt-5.6-sol` | `xhigh` | Heavy backend/infra work when its higher latency is justified |
| `worker` | `third-party/deepseek-v4-flash` | `max` | Default routine implementation; aliases: `developer`, `coder`, `implementer`, `develop` |

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
git add .gitignore settings.json pi-retry.json pi-continue-watchdog.json pi-notify.json pi-notify-bark.cjs extensions README.md AGENTS.md skills agents
git commit -m "feat: describe the change"
git push
```

Inside Pi, run `/reload` after editing extensions, skills, prompts, themes, or context files such as `AGENTS.md`.

## Security

Never commit:

- `auth.json` or provider credentials
- `sessions/` or exported conversations
- `trust.json`
- `.env` files, `pi-notify-bark.secret`, or literal API keys
- `cache/`, `npm/`, `git/`, `.pi/`, or generated model stores

Configuration files committed to this repository must not contain endpoint credentials. Provider API keys and private base URLs belong in environment variables.

## License

MIT — see [LICENSE](LICENSE).
