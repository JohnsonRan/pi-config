# JohnsonRan Pi Config

Personal extensions and global configuration for [Pi](https://pi.dev).

> **Security:** Pi extensions run with the current user's full system permissions. Review the source before installing.

## What's included

- `extensions/pi-web.ts` — `web_search` and `web_fetch`, with Firecrawl → Tavily → Exa fallback.
- `extensions/third-party-provider.ts` — registers models from an OpenAI-compatible provider and discovers metadata from `/models` and public catalogs.
- `settings.json` — global preferences, packages, and default model.
- `pi-retry.json` and `pi-continue-watchdog.json` — retry and continuation-watchdog settings.
- `pi-notify.json` and `pi-notify-bark.cjs` — OSC/Bark notifications and retraction support.
- `agents/*.md` — specialized subagent definitions.

## Install

```powershell
pi install git:github.com/JohnsonRan/pi-config
```

Pi reads the extensions declared in `package.json`. Installed packages have full system access. This repository currently has no release tag to pin.

## Configure

### Web search and fetch

The extension registers two provider-neutral tools:

- `web_search` — search the web.
- `web_fetch` — fetch a valid HTTP(S) URL as clean Markdown; URLs with embedded credentials are rejected.

Providers are tried in this order:

1. Firecrawl, when `FIRECRAWL_API_KEY` is set
2. Tavily, when `TAVILY_API_KEY` is set
3. Exa, including its anonymous endpoint when `EXA_API_KEY` is absent

Firecrawl and Tavily require keys. An Exa key avoids the shared anonymous rate limit. Missing keys skip that provider; rate limits, quota/credential failures, upstream `5xx` responses, timeouts, and network failures fall through to the next provider. Persistent quota, plan, or credential failures remain disabled for the current extension load, so run `/reload` after fixing a key or adding credits. Invalid URLs and parameters fail immediately instead of being hidden by fallback.

```powershell
[Environment]::SetEnvironmentVariable("FIRECRAWL_API_KEY", "fc-your-key", "User")
[Environment]::SetEnvironmentVariable("TAVILY_API_KEY", "tvly-your-key", "User")
[Environment]::SetEnvironmentVariable("EXA_API_KEY", "your-exa-key", "User")
```

### Third-party model provider

Required:

```powershell
[Environment]::SetEnvironmentVariable("PI_THIRD_PARTY_BASE_URL", "https://your-provider.example/v1", "User")
[Environment]::SetEnvironmentVariable("THIRD_PARTY_API_KEY", "your-key", "User")
```

The default adapter is `openai-responses`, so the gateway must implement the Responses API at `<baseUrl>/responses`. For a Chat Completions-only gateway:

```powershell
[Environment]::SetEnvironmentVariable("PI_THIRD_PARTY_API", "openai-completions", "User")
```

Useful optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_THIRD_PARTY_PROVIDER_ID` | `third-party` | Pi provider ID |
| `PI_THIRD_PARTY_PROVIDER_NAME` | `Third-party API` | Display name |
| `PI_THIRD_PARTY_API` | `openai-responses` | API adapter |
| `PI_THIRD_PARTY_MODELS_FILE` | `~/.pi/agent/third-party-models.json` | Local metadata override |
| `PI_THIRD_PARTY_CONTEXT_WINDOW` | `128000` | Fallback context window |
| `PI_THIRD_PARTY_MAX_TOKENS` | `16384` | Fallback output limit |
| `PI_THIRD_PARTY_CATALOG` | enabled | Set to `off` to disable models.dev metadata |
| `PI_THIRD_PARTY_PI_CATALOG` | enabled | Set to `off` to disable Pi catalog metadata |

Models are loaded from the provider's `/models` endpoint. Metadata can also come from models.dev and Pi's catalog; local catalog files and provider filters are supported through the corresponding `PI_THIRD_PARTY_*` variables in `extensions/third-party-provider.ts`.

### CLIProxyAPI WebSocket transport

Select the transport in Pi's **Settings → Transport** menu:

| Transport | Behavior |
| --- | --- |
| `sse` | Standard Responses HTTP/SSE; default |
| `auto` | Try WebSocket, then fall back to SSE before sending the request |
| `websocket` | Require WebSocket and send full context |
| `websocket-cached` | Require WebSocket and reuse matching session state incrementally |

For CLIProxyAPI, expose WebSocket upgrades on `/v1/responses` and use the normal bearer key. To use WebSocket end to end, enable `websockets: true` in the selected CLIProxyAPI Codex auth. `auto` falls back to SSE only when the WebSocket fails before the request is sent; after `response.create`, errors are returned without replaying the request, avoiding duplicate generation, billing, tool calls, or other side effects.

## Global setup

To use this repository as the active global configuration, install or clone it at `~/.pi/agent`. If you already have a Pi configuration, merge selected fields from `settings.json` rather than overwriting it.

The tracked settings reference these separately maintained Pi packages:

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

`i-have-adhd` is intentionally not bundled. Install and update it from upstream:

```powershell
npx skills add ayghri/i-have-adhd -a pi -y -g
npx skills update i-have-adhd -g
```

### Specialized subagents

Definitions under `agents/` are loaded globally from `~/.pi/agent/agents/`. The built-in `scout` and `delegate` agents are overridden in `settings.json`.

| Agent | Model | Thinking | Fallback | Role |
| --- | --- | --- | --- | --- |
| `scout` (built-in override) | `third-party/gpt-5.6-luna` | `xhigh` | `third-party/deepseek-v4-flash:max` | Codebase exploration and compressed context handoff |
| `delegate` (built-in override) | `third-party/gpt-5.6-luna` | `xhigh` | `third-party/deepseek-v4-flash:max` | Generic isolated work |
| `Plan` | `third-party/kmc/k3` | `high` | — | Read-only planning; writes `plan.md` |
| `code-merge-reviewer` | `third-party/gpt-5.6-luna` | `max` | `third-party/deepseek-v4-flash:max` | Final pre-push or merge review |
| `frontend-engineer` | `third-party/kmc/k3` | `max` | — | Frontend implementation and browser-backed verification |
| `oracle` | `third-party/gpt-5.6-sol` | `max` | — | Project or plan reflection and course correction |
| `researcher` | `third-party/gpt-5.6-terra` | `high` | — | Source-backed research; writes `research.md` |
| `reviewer` | `third-party/gpt-5.6-sol` | `medium` | — | Focused implementation quality gate |
| `reviewer-final` | `third-party/gpt-5.6-sol` | `xhigh` | — | Final quality gate after implementation and testing |
| `tester` | `third-party/gpt-5.6-sol` | `medium` | — | Test design, automation, and acceptance verification |
| `ui-leader` | `third-party/kmc/k3` | `max` | — | Product, information architecture, and UI direction |
| `worker-auto` | `third-party/grok-4.5` | `high` | — | Fast automation work |
| `worker-pro-backend` | `third-party/gpt-5.6-sol` | `xhigh` | — | Heavy backend and infrastructure work |
| `worker` | `third-party/gpt-5.6-sol` | `medium` | — | Default routine implementation; aliases: `developer`, `coder`, `implementer`, `develop` |

The configured models must exist in Pi's model registry. Verify one with, for example:

```powershell
pi --list-models gpt-5.6-sol
```

A project-specific definition at `<project>/.pi/agents/<agent-name>.md` takes precedence over the global definition. Run `/reload` or start a new session after changing extensions, skills, prompts, context files, or agent definitions.

### Notifications and Bark

`pi-notify.json` sends OSC notifications and Bark pushes for user questions, completed work, explicit `agent-notify` events, and continuation-watchdog failures.

Create an untracked `~/.pi/agent/pi-notify-bark.secret` containing one Bark push URL, for example:

```text
https://api.day.app/your-device-key
```

The helper derives the `/push` endpoint, uses the `pi-notify` group, and keeps the device key out of tracked files. Question notifications are tied to their tool call and are withdrawn only after the push has been accepted for at least 60 seconds. Completion notifications are withdrawn on the next interactive input; RPC and extension-injected inputs do not trigger immediate withdrawal. Session shutdown cancels delayed timers and attempts to withdraw remaining notifications.

The trusted `js:` actions load `pi-notify-bark.cjs` with Node's `createRequire` because their `Function` execution context may not support dynamic `import()`. Keep the secret local and restart Pi after changing the helper because Node caches the CommonJS module.

## Development

The allowlist-style `.gitignore` intentionally excludes credentials, sessions, caches, installed packages, trust decisions, and generated model data.

Refresh Pi according to the resource changed:

| Change | Required action |
| --- | --- |
| Extensions, skills, prompts, themes, or context files | Run `/reload` |
| Persistent environment variables or API adapter | Restart the terminal and Pi |
| `agents/*.md` | Run `/reload` or start a new session |
| `pi-notify-bark.cjs` | Restart Pi; Node caches the CommonJS helper |

After editing a resource:

```powershell
git status
git diff
git add .gitignore settings.json pi-retry.json pi-continue-watchdog.json pi-notify.json pi-notify-bark.cjs extensions README.md agents
git commit -m "feat: describe the change"
git push
```

## Security

Never commit credentials or generated state, including `auth.json`, provider keys, `.env` files, `pi-notify-bark.secret`, sessions, caches, `trust.json`, or installed package directories. Keep provider keys and private base URLs in environment variables.

## License

MIT — see [LICENSE](LICENSE).
