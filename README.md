# JohnsonRan Pi Config

Personal extensions and global configuration for [Pi](https://pi.dev).

> **Security:** Pi extensions run with the current user's full system permissions. Review the source before installing.

## What's included

- `extensions/pi-web.ts` — `web_search` and `web_fetch`, with Firecrawl → Tavily → Exa fallback.
- [`JohnsonRan/pi-btw`](https://github.com/JohnsonRan/pi-btw) — `/btw` side questions that use session context without interrupting or entering the main conversation.
- `settings.json` — global preferences, packages, CLIProxyAPI default provider, and default model.
- `pi-retry.json` and `pi-continue-watchdog.json` — retry and continuation-watchdog settings.
- `pi-notify.json` — local BEL/OSC notifications for questions, completed work, and explicit agent notifications.
- [`JohnsonRan/pi-telegram-operator`](https://github.com/JohnsonRan/pi-telegram-operator) — threaded Telegram topics, streamed replies, remote controls, and session wake-up.
- [`xz-dev/pi-reflect-watchdog`](https://github.com/xz-dev/pi-reflect-watchdog) — active-time and loop watchdog with explicit `/reflect` support.
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
pi install git:github.com/xz-dev/pi-hermes-memory
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
pi install git:github.com/ayghri/i-have-adhd
pi install npm:pi-subagents
pi install git:github.com/JohnsonRan/pi-btw
pi install git:github.com/JohnsonRan/pi-telegram-operator
pi install git:github.com/JohnsonRan/pi-cliproxyapi-provider
pi install git:github.com/xz-dev/pi-reflect-watchdog
```

### Specialized subagents

Definitions under `agents/` are loaded globally from `~/.pi/agent/agents/`. The built-in `scout` and `delegate` agents are overridden in `settings.json`.

| Agent | Model | Thinking | Fallback | Role |
| --- | --- | --- | --- | --- |
| `scout` (built-in override) | `cliproxyapi/gemini-3.7-flash-high` | `high` | `cliproxyapi/gemini-3.7-flash-high:high` | Codebase exploration and compressed context handoff |
| `delegate` (built-in override) | `cliproxyapi/gpt-5.6-luna` | `xhigh` | `cliproxyapi/gemini-3.7-flash-high:high` | Generic isolated work |
| `Plan` | `cliproxyapi/kimi-k3` | `max` | — | Read-only planning; writes `plan.md` |
| `code-merge-reviewer` | `cliproxyapi/gpt-5.6-luna` | `max` | `cliproxyapi/gemini-3.7-flash-high:high` | Final pre-push or merge review |
| `frontend-engineer` | `cliproxyapi/kimi-k3` | `max` | — | Frontend implementation and browser-backed verification |
| `oracle` | `cliproxyapi/gpt-5.6-sol` | `max` | — | Project or plan reflection and course correction |
| `researcher` | `cliproxyapi/gemini-3.7-flash-high` | `high` | — | Source-backed research; writes `research.md` |
| `reviewer` | `cliproxyapi/gpt-5.6-sol` | `medium` | — | Focused implementation quality gate |
| `reviewer-final` | `cliproxyapi/gpt-5.6-sol` | `xhigh` | — | Final quality gate after implementation and testing |
| `tester` | `cliproxyapi/gpt-5.6-sol` | `medium` | — | Test design, automation, and acceptance verification |
| `ui-leader` | `cliproxyapi/kimi-k3` | `max` | — | Product, information architecture, and UI direction |
| `worker-auto` | `cliproxyapi/grok-4.6` | `medium` | — | Fast automation work |
| `worker-pro-backend` | `cliproxyapi/gpt-5.6-sol` | `xhigh` | — | Heavy backend and infrastructure work |
| `worker` | `cliproxyapi/gpt-5.6-sol` | `medium` | — | Default routine implementation; aliases: `developer`, `coder`, `implementer`, `develop` |

The configured models must exist in Pi's model registry. Verify one with, for example:

```powershell
pi --list-models gpt-5.6-sol
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
git add .gitignore settings.json pi-retry.json pi-continue-watchdog.json pi-notify.json extensions README.md agents
git commit -m "feat: describe the change"
git push
```

## Security

Never commit credentials or generated state, including `auth.json`, provider keys, `.env` files, `pi-telegram-operator.secret`, `pi-telegram-operator.json`, `pi-telegram-operator.state.json`, sessions, caches, `trust.json`, or installed package directories. Keep provider keys and private base URLs in environment variables.

## License

MIT — see [LICENSE](LICENSE).
