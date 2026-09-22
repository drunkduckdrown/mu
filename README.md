<p align="center">
  <img alt="μ" src="desktop/resources/app.png" width="112">
</p>

<h1 align="center">mu</h1>

<p align="center"><b>A coding agent that thinks before it acts.</b><br>
A small, fast judge makes the routine calls. The big model keeps its attention for the work.</p>

<p align="center">
  <b>English</b> · <a href="docs/readme/README.zh-CN.md">简体中文</a> · <a href="docs/readme/README.zh-TW.md">繁體中文</a> · <a href="docs/readme/README.ja.md">日本語</a> · <a href="docs/readme/README.ko.md">한국어</a>
</p>

> **Status: early development.** mu works day to day for its authors, but nothing here is released yet. Names, settings and file formats may still change. Features marked *experimental* have not been tried on real accounts or real machines of every kind; the docs say exactly what has and has not been verified.

---

## Why mu

A coding agent spends a surprising share of its model calls, and of its context window, on small questions. Is this message a new task or a correction? Does this command need the user's permission? Which part of a 4,000-line test log matters? Is the agent going in circles? Which sub-agent and which model fit this job? What should the browser click next?

mu hands those questions to a **judge**: a fast model that answers typed yes/no and multiple-choice questions in a fraction of a second. Code acts on the answers. The main model, the one that reads and writes your code, only sees what it needs.

- **Every decision is visible.** Each one has a mode: `off`, `shadow` (asked and logged, but not acted on) or `active`. The verdicts and timings go to a ledger (`/ledger`, `mu ledger`).
- **Every decision fails open.** If the judge is unsure, slow or unreachable, a plain rule decides, or pi's stock behaviour runs.
- **The judge is pluggable.** mu can use [JeV](kyrn/docs/08-jev-retrospective.md) (hosted, through the Vercel AI Gateway), *Laya* (a local judge on macOS, Core ML), any language model you already use, or several of these in tiers, where a later judge only gets what an earlier one was unsure of.

mu is built on [pi](https://github.com/earendil-works/pi), a minimal, extensible terminal coding agent. It keeps pi's core almost untouched and adds its judgment layer as an extension (`packages/kyrn-judge`). The desktop app is built on [AionUi](https://github.com/iOfficeAI/AionUi).

## What it does today

**Judgment layer**, with 29 decision points in 32 features:

- **Reads every message first.** The judge decides what kind of turn it is (new task, correction, new constraint, side question), how much reasoning it needs and whether to plan first. The message waits above the editor while this happens (`esc` skips the wait), and the verdict stays under it in the chat.
- **Task frame.** mu keeps the goal, your hard constraints in your own words with where you said them, the current subgoal and an acceptance checklist. Before an edit, the change is checked against your constraints, and a clear violation is blocked with your words quoted. `/frame` shows it.
- **Keeps the context lean.** Repeated failures in test logs are kept once. Tools, MCP servers, language servers and packs are installed but hidden until the task needs them (capability catalog). Only new compiler errors are reported (LSP diagnostics against a baseline). Skills and lessons are chosen per task.
- **Permissions in three modes.** *Full access*; *JeV approves* (the judge approves what the task clearly needs and asks you about the rest); *Minimal* (everything but reading asks). Switch with `/permissions`. When a step needs your approval, a prompt appears in the status bar.
- **Goal mode.** `/goal <condition>` keeps the agent working until the condition holds. A language model reads the evidence each time the agent wants to stop. Hard facts win: an open checklist item, or an edit nothing checked, means not done yet.
- **Plain-language board.** Every few steps, the judge picks what is actually news and a model that explains well retells it, for people who do not read code: how far the work is, what is happening now, what waits on you. When a run ends, the board sums it up. Switch it on per project with `/board on`.
- **Checkpoints and rewind.** Before the first edit of each turn, the workspace is snapshotted in a shadow git directory; your own index and stash are never touched. `/rewind` restores the files, the conversation, or both. When the agent keeps failing the same way, the judge can suggest a rewind; it never rewinds by itself.

**Sub-agents and the browser**

- **`delegate`.** Independent parts run in parallel, or as a chain of steps. Parts that edit work in their own git worktree and hand back a patch. Each sub-agent works to its own checklist and reports it back. `/implement`, `/scout-and-plan` and `/implement-and-review` are ready-made chains.
- **`hive`.** For one hard problem, several investigators work at once, and the judge decides which findings pass between them.
- **Built-in browser.** `browse` runs a loop of observe, one judge call, act. In the desktop app you watch every step in its own browser panel and can take over at any time. Anything irreversible asks first.

**Everyday tools**

- **Picks up what you already have.** mu reads the rules, skills and MCP servers you set up for Claude Code, Cursor and Codex.
- **Packs.** `/review` with findings ranked P0–P3, and `/commit`, which splits a change into commits and shows the plan first. Also ast-grep, GitHub through `gh`, conflict resolution and a DAP debugger (debugpy, delve, lldb-dap).
- **Background jobs, web fetch and search** (with sources that work from mainland China), and **sign-in** with Claude, ChatGPT, Grok and Google (Google through Gemini CLI or Antigravity is *experimental*: mu states the risk and asks before the browser opens).

**Desktop app** (`desktop/`)

- A JeV panel shows every verdict.
- The browser panel is driven by mu.
- It shows the plain-language board and the permission prompts.
- Settings are generated from the harness's own manifest: judges, decision modes, features, providers with OpenAI- or Anthropic-compatible endpoints.
- A guided first start and sign-in.
- The interface in 13 languages.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/kyrn-judge` | mu itself: the judgment kernel, the 29 decision specs and every feature above, as a pi extension |
| `packages/*` (others) | pi's monorepo: `ai` (providers), `agent` (the loop), `coding-agent` (the CLI), `tui`, … with a few small patches |
| `kyrn/bin` | the `mu` launcher (`mu`, `mu.cmd`, `mu.ps1`; Node, no dependencies) |
| `kyrn/docs` | design notes, the product plan and one document per feature (mostly in Chinese) |
| `kyrn/local-judge` | the local judge Laya (macOS, Core ML) |
| `desktop/` | the desktop app (Electron, an AionUi fork) |

*KYRN* was the project's earlier name. It survives in folder and package names.

## Install

```bash
npm i -g mu-agent
mu
```

You need Node.js 22.19 or newer. The package is called `mu-agent`; the command is `mu`. It runs on macOS, Linux, Windows and WSL. `npm i -g mu-agent@latest` updates it. Everything below works the same way, except that the JeV key goes in your environment or in `~/.mu/.env`, not in `kyrn/.env`.

## Get started from source

You need Node.js 22.19 or newer (24 recommended), npm and git.

```bash
git clone https://github.com/qybaihe/MU.git
cd MU
npm install
kyrn/bin/mu            # Windows: kyrn\bin\mu.cmd
```

Inside mu, `/login` signs in to a model provider and `/model` picks a model. `/help` lists everything, and `/doctor` checks the setup. To put `mu` on your PATH, run `kyrn/bin/mu link`.

**Choose a judge.** Without one, mu works like pi with the extra tools.

- **JeV:** put a Vercel AI Gateway key in `kyrn/.env` as `AI_GATEWAY_API_KEY` (see `kyrn/.env.example`).
- **Laya, local, macOS only:** run `mu judge setup`. It downloads about 930 MB and asks before it starts.
- **Any model you already use:** `/mu judge llm:<provider>/<model>`.

Decisions start in `shadow` mode, so you can watch what the judge would do. When you trust it, run `/mu mode default active`, or set `"modes": {"default": "active"}` in `~/.mu/agent/mu.json`.

**Desktop app from source**, with [Bun](https://bun.sh):

```bash
cd desktop
bun install
KYRN_ROOT="$(cd .. && pwd)" bun run start     # Windows (PowerShell): $env:KYRN_ROOT = (Resolve-Path ..); bun run start
```

The app runs mu from the checkout that `KYRN_ROOT` names, so run `npm install` at the repository root first.

## Builds

GitHub Actions checks every push. It builds the desktop app for every common platform, and publishes a release for every `v*` tag:

| | x64 | arm64 |
| --- | --- | --- |
| **macOS** | `.dmg`, `.zip` (Intel) | `.dmg`, `.zip` (Apple silicon) |
| **Windows** | `.exe` installer | `.exe` installer |
| **Linux** | `.deb` | `.deb` |

Every release also has a source archive of the repository.

These are **preview builds**:

- They are not code-signed yet. macOS asks you to confirm the first start in *System Settings → Privacy & Security*, and Windows SmartScreen shows a warning.
- The app does not carry mu inside it yet. It runs mu from a checkout of this repository on the same machine, so set `KYRN_ROOT` to that checkout.

The `mu` command line comes from npm (`npm i -g mu-agent`, see above) on all of these platforms, or runs from source.

## What we are working on

- **mu inside the app, and as standalone binaries.** A downloaded app should work on its own, with no checkout and no `KYRN_ROOT`, and the `mu` command should come as one file per platform.
- **The app as the main way to use mu.** The whole flow runs inside the desktop app, not through a terminal bridge. That means a native conversation view fed by one ordered event stream.
- **One-click local judge.** Install Laya from the settings, with its size and source shown and your consent asked before anything downloads.
- **Windows and WSL on real machines.** The code paths exist and are unit-tested; they still need a real Windows machine.
- **Measuring the judge.** For each decision point, how often JeV and Laya are right on real sessions, so the thresholds can be tuned.
- **Semantic drift checks** (*experimental*). The judge watches the model's output as it streams and stops it only when it clearly breaks a rule you set.

The detailed plan, with the status of each item, is in [kyrn/docs/11-out-of-the-box-roadmap.md](kyrn/docs/11-out-of-the-box-roadmap.md) (Chinese).

## Contributing

Read [AGENTS.md](AGENTS.md) first. In short: tab indentation, relative imports with `.ts`, only erasable TypeScript syntax, exact dependency versions. Run `npm run check` and the tests you touched. The full suite is slow, so leave it to CI, which runs it on every push. Tests use a mock judge and a fake model, and never call a real model.

## Credits and license

- **pi**, by Mario Zechner and contributors, is MIT-licensed. The root [LICENSE](LICENSE) covers `packages/` and `kyrn/`.
- **The desktop app is based on [AionUi](https://github.com/iOfficeAI/AionUi)** by iOfficeAI, licensed under Apache 2.0. It is called mu inside the app, but much of its code comes from AionUi, and we are grateful for it. `desktop/` keeps AionUi's [LICENSE](desktop/LICENSE).
- Third-party code in the judgment layer is listed in [packages/kyrn-judge/THIRD_PARTY_NOTICES.md](packages/kyrn-judge/THIRD_PARTY_NOTICES.md).
