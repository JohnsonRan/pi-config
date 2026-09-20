# JohnsonRan Pi Config

Personal extensions and global configuration for [Pi](https://pi.dev).

> **Security:** Pi extensions run with the current user's full system permissions. Review the source before installing.

## What's included

- `extensions/pi-web.ts` — `web_search` and `web_fetch`, with Firecrawl → Tavily → Exa fallback.
- [`JohnsonRan/pi-btw`](https://github.com/JohnsonRan/pi-btw) — `/btw` side questions that use session context without interrupting or entering the main conversation.
- `settings.json` — global preferences, packages, CLIProxyAPI default provider, and default model.
- `hindsight.json` and `.pi/hindsight.json` — global coding-bank selection and this repository's Hindsight memory profile; no credentials or memory data.
- `pi-retry.json` and `pi-continue-watchdog.json` — retry and continuation-watchdog settings.
- `pi-notify.json` — local BEL/OSC notifications for questions, completed work, and explicit agent notifications.
- [`JohnsonRan/pi-telegram-operator`](https://github.com/JohnsonRan/pi-telegram-operator) — threaded Telegram topics, streamed replies, remote controls, and session wake-up.
- [`xz-dev/pi-reflect-watchdog`](https://github.com/xz-dev/pi-reflect-watchdog) — active-time and loop watchdog with explicit `/reflect` support.
- [`xz-dev/rpiv-mono@release/ask-user-question`](https://github.com/xz-dev/rpiv-mono) — `ask_user_question` TUI questionnaires instead of guessing.
- [`JohnsonRan/pi-jev`](https://github.com/JohnsonRan/pi-jev) — TypeSafe Jev auto-mode classifier for mutating tools (`/jev`).
- `agents/*.md` — specialized subagent definitions.
- `skills/web-perf/SKILL.md` — Chrome DevTools-based web performance audit workflow.

## Install

```powershell
pi install git:github.com/JohnsonRan/pi-config
```

Pi reads the extensions declared in `package.json`. Installed packages have full system access. This repository currently has no release tag to pin.

## Configure

### Side questions

The separately maintained [`pi-btw`](https://github.com/JohnsonRan/pi-btw) package provides `/btw <question>` to ask the active model a tool-free question about the current session. The main agent keeps running, and the question and answer are not added to its conversation context. The answer opens in a dismissible overlay; use `Left`/`Right` to browse up to 20 answers from the current extension load, or run `/btw` without arguments to reopen the latest answer.

```text
/btw which config file are we editing?
```

The extension sends a serialized snapshot of the current, compaction-aware session context in a separate model request. Unlike Claude Code's native implementation, Pi extensions cannot reuse the main request's provider prompt cache, so long sessions may incur additional input-token cost.

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

### CLIProxyAPI model provider

Model discovery and inference are supplied by the separately maintained [`pi-cliproxyapi-provider`](https://github.com/JohnsonRan/pi-cliproxyapi-provider) package. Configure it interactively:

```text
/login CLIProxyAPI
```

Enter the CLIProxyAPI base URL and API key. The package discovers models dynamically, registers them under the `cliproxyapi` provider, and caches model metadata locally. Run `/cliproxyapi-refresh` after changing the proxy's model catalog.

The tracked startup defaults are `cliproxyapi/gpt-6-astra` with `high` thinking. Subagents use their own model and thinking settings below.

### Automatic retries

`settings.json` enables Pi's agent-level automatic retries with `maxRetries: 10`. Errors containing `quota threshold` (case-insensitive) skip these retries, in addition to Pi's built-in non-retryable quota and billing patterns. The separate `pi-retry.json` configures the installed retry extension.

## Global setup

To use this repository as the active global configuration, install or clone it at `~/.pi/agent`. If you already have a Pi configuration, merge selected fields from `settings.json` rather than overwriting it.

The tracked settings reference these separately maintained Pi packages:

```powershell
pi install npm:context-mode
pi install git:github.com/xz-dev/pi-continuity
pi install npm:pi-powerline-footer
pi install git:github.com/xz-dev/human-handoff-skill
pi install git:github.com/xz-dev/SuperAgents-skill
pi install git:github.com/xz-dev/i-read-the-code-skill
pi install npm:browser-goblin
pi install git:github.com/luxus/pi-hindsight
pi install git:github.com/xz-dev/pi-continue-watchdog
pi install git:github.com/xz-dev/conventional-commits-skill
pi install git:github.com/xz-dev/pi-retry
pi install git:github.com/xz-dev/pi-notify
pi install git:github.com/xz-dev/pi-double-confirm-interrupt
pi install git:github.com/jonjonrankin/pi-caveman
pi install git:github.com/DietrichGebert/ponytail
pi install git:github.com/nicobailon/pi-intercom
pi install npm:@juicesharp/rpiv-todo
pi install npm:pi-cache-optimizer
pi install git:github.com/nicobailon/pi-subagents
pi install git:github.com/JohnsonRan/pi-btw
pi install git:github.com/JohnsonRan/pi-telegram-operator
pi install git:github.com/JohnsonRan/pi-cliproxyapi-provider
pi install git:github.com/xz-dev/pi-reflect-watchdog
pi install git:github.com/xz-dev/rpiv-mono@release/ask-user-question
pi install git:github.com/JohnsonRan/pi-jev
```

### Hindsight memory

The separately maintained [`pi-hindsight`](https://github.com/luxus/pi-hindsight) package replaces `pi-hermes-memory`.

- `~/.pi/agent/hindsight.json` selects the shared `pi-coding` bank globally and the `pi-user-melody` user bank.
- `.pi/hindsight.json` configures this repository for domain-tagged coding memory, automatic coding recall/retain, and enabled user memory with explicit-only user retain. Other repositories need their own `/hindsight` setup.
- Keep `HINDSIGHT_BASE_URL` and `HINDSIGHT_API_TOKEN` in your local environment; neither is stored in this repository.

Installing this repository as a Pi package does not copy these config files into active config locations. Merge them into the paths above when not using this checkout as `~/.pi/agent`, then restart Pi. Bank missions, mental models, and memory data remain on the Hindsight server; local queues, import checkpoints, and caches under `.pi/hindsight/` stay ignored.

### Specialized subagents

Definitions under `agents/` are loaded globally from `~/.pi/agent/agents/`. The `pi-subagents` package now comes from its Git repository rather than npm. Its built-in `scout`, `delegate`, `researcher`, and `evidence-auditor` agents are overridden in `settings.json`. The local `agents/researcher.md` has been removed in favor of the built-in researcher.

The built-in overrides do not configure fallback models. Fallbacks for local agents are listed in configured order; `:<level>` suffixes specify thinking levels.

| Agent | Model | Thinking | Fallbacks | Role |
| --- | --- | --- | --- | --- |
| `scout` (built-in override) | `cliproxyapi/gemini-3.8-flash-high` | `high` | — | Codebase exploration and compressed context handoff |
| `delegate` (built-in override) | `cliproxyapi/gemini-3.8-flash-high` | `high` | — | Generic isolated work |
| `researcher` (built-in override) | `cliproxyapi/gemini-3.8-flash-high` | `high` | — | Source-backed research; writes `research.md` |
| `evidence-auditor` (built-in override) | `cliproxyapi/grok-4.6` | `max` | — | Independent verification of decision-critical research claims and sources |
| `Plan` | `cliproxyapi/gpt-6-astra` | `max` | `cliproxyapi/kimi-k3:max`, `cliproxyapi/glm-5.3:max` | Read-only planning; writes `plan.md` |
| `code-merge-reviewer` | `cliproxyapi/glm-5.3-flash` | `max` | `cliproxyapi/gpt-5.6-luna:max`, `cliproxyapi/gemini-3.8-flash-high:medium` | Final pre-push or merge review |
| `frontend-engineer` | `cliproxyapi/kimi-k3` | `max` | — | Frontend implementation and browser-backed verification |
| `oracle` | `cliproxyapi/gpt-6-astra` | `max` | `cliproxyapi/kimi-k3:max`, `cliproxyapi/glm-5.3:max` | Project or plan reflection and course correction |
| `reviewer` | `cliproxyapi/gpt-6-astra` | `medium` | `cliproxyapi/kimi-k3:max`, `cliproxyapi/glm-5.3:max` | Focused implementation quality gate |
| `reviewer-final` | `cliproxyapi/gpt-6-astra` | `xhigh` | `cliproxyapi/kimi-k3:max`, `cliproxyapi/glm-5.3:max` | Final quality gate after implementation and testing |
| `tester` | `cliproxyapi/grok-4.6` | `medium` | `cliproxyapi/glm-5.3:low` | Test design, automation, and acceptance verification |
| `ui-leader` | `cliproxyapi/kimi-k3` | `max` | — | Product, information architecture, and UI direction |
| `worker-auto` | `cliproxyapi/glm-5.3` | `max` | `cliproxyapi/kimi-k3:max` | Fast automation work |
| `worker-pro-backend` | `cliproxyapi/gpt-6-astra` | `xhigh` | `cliproxyapi/kimi-k3:max`, `cliproxyapi/glm-5.3:max` | Heavy backend and infrastructure work |
| `worker` | `cliproxyapi/gemini-3.8-flash-high` | `high` | `cliproxyapi/glm-5.3:medium`, `cliproxyapi/kimi-k3:medium` | Default routine implementation; aliases: `developer`, `coder`, `implementer`, `develop` |

The configured models must exist in Pi's model registry. Verify one with, for example:

```powershell
pi --list-models gpt-6-astra
```

A project-specific definition at `<project>/.pi/agents/<agent-name>.md` takes precedence over the global definition. Run `/reload` or start a new session after changing extensions, skills, prompts, context files, or agent definitions.

### Notifications and Telegram

`pi-notify.json` keeps local notifications lightweight: questions and explicit `agent-notify` events emit BEL and OSC messages, while completed work and continuation-watchdog failures emit OSC messages.

The separately maintained [`pi-telegram-operator`](https://github.com/JohnsonRan/pi-telegram-operator) package provides the remote operator path. It assigns each Pi session a Telegram topic, streams assistant replies, routes topic replies back as Pi user messages, exposes session controls and Pi commands, and can optionally wake stopped sessions. Enable Threaded Mode for the bot in `@BotFather`, install the package, restart Pi, then run its `setup.cjs` utility from the installed checkout.

The Telegram extension listens directly for `ask_user_question`, `user-ready`, and `agent-notify` events. Keep Telegram actions out of `pi-notify.json` to avoid duplicate messages. Its bot token, broker configuration, state, and logs stay in untracked `pi-telegram-operator.*` files under `~/.pi/agent`.

## Development

The allowlist-style `.gitignore` intentionally excludes credentials, sessions, caches, installed packages, trust decisions, and generated model data.

Refresh Pi according to the resource changed:

| Change | Required action |
| --- | --- |
| Extensions, skills, prompts, themes, or context files | Run `/reload` |
| Persistent environment variables or provider configuration | Restart the terminal and Pi |
| `agents/*.md` | Run `/reload` or start a new session |
| Installed package configuration or background services | Restart Pi or the relevant service |

After editing a resource:

```powershell
git status
git diff
git add .gitignore settings.json hindsight.json .pi/hindsight.json pi-retry.json pi-continue-watchdog.json pi-notify.json extensions README.md agents
git commit -m "feat: describe the change"
git push
```

## Security

Never commit credentials or generated state, including `auth.json`, provider keys, `.env` files, `pi-telegram-operator.secret`, `pi-telegram-operator.json`, `pi-telegram-operator.state.json`, sessions, caches, `trust.json`, or installed package directories. Keep provider keys and private base URLs in environment variables.

## License

MIT — see [LICENSE](LICENSE).
