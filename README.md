<p align="center">
  <img src="desktop/resources/app.png" width="96" alt="mu">
</p>
<p align="center">μ · Only what's needed.</p>

<p align="center">
  <b>English</b> · <a href="docs/readme/README.zh-CN.md">简体中文</a> · <a href="docs/readme/README.zh-TW.md">繁體中文</a> · <a href="docs/readme/README.ja.md">日本語</a> · <a href="docs/readme/README.ko.md">한국어</a>
</p>

# mu

mu is a coding agent with a judgment kernel: a deep fork of pi, a layer of judgment called Jev, and a desktop app.

- **mu**: the command line. Everything pi does, plus Jev's judgment layer.
- **mu desktop**: a native desktop app that carries mu inside it. Download and run.
- **Jev**: a small judge model that answers in about a hundred milliseconds. The big model does the work; at each decision point, Jev answers one question: what is needed now?

> Early development. Its authors use it every day, but nothing has been released yet. Names, settings and file formats may still change.

## Install

**Desktop.** GitHub Actions builds the installers and publishes them under [Releases](https://github.com/qybaihe/mu/releases): macOS (Apple silicon / Intel), Windows (x64 / Arm), Linux (x64 / Arm). The app carries its runtime and mu itself, so there is no Node to install and nothing to configure. Open it, connect a model (an API key or a subscription sign-in) and Jev's key, and start.

<!-- Keep this line until the app is signed and notarized -->
If macOS says the developer cannot be verified: right-click the app in Finder and choose Open, once.

**Command line.**

```bash
npm i -g mu-agent
mu
```

Node 22.19 or newer. The desktop app and the command line share the accounts, settings and lessons in `~/.mu`.

## Where Jev is

You do not notice Jev. It never asks you one more question on the model's behalf, and it adds no button to the interface; it only changes what the model does next. In every turn, it is here:

- **When you speak.** Whether this message is a new task, a follow-up or a correction, before any work starts; whether to interrupt when you say something while the agent is busy.
- **Before acting.** Whether a command could do something irreversible; whether it passes the rules you set; in the *Jev approves* permission mode, what needs your approval and what does not.
- **When a tool returns.** What belongs in the context and what is repetition and noise; in a test log, the failures stay and the repeats go; stale results are let go.
- **As the context grows.** What can be dropped without writing a summary; whether a cache about to expire is worth keeping warm. This is why the cache hit rate stays high and the context never fills up.
- **When a turn ends.** Whether the work is done, checked by the big model with Jev as the fallback; whether the agent drifted from the task; whether to go back to a checkpoint.
- **When learning.** Your corrections, the traps the agent worked around, the lessons sub-agents bring back: whether they are worth keeping, whether they are the same as an existing lesson or contradict it, whether they were followed this time. A lesson nobody follows retires on its own.
- **With several agents.** Which role a task goes to; whether a sub-agent's patch stayed within its bounds; which finding in a hive is worth passing to another bee.

More than thirty decision points, each chosen separately in the settings: Jev, a local judge (Laya, a model that runs on your machine and never touches the network), or off. Every verdict goes to a ledger that the desktop app's side panel shows.

## The hive

Every multi-agent system has to answer the same question: should what one agent knows be told to another? There are four common answers: pass nothing and report only to the main agent; pass everything, the whole history in a group chat or a hand-off; let each agent's own big model decide; or rely on fixed rules and the environment (subscriptions, git). mu's answer is a fifth: let Jev be the gate.

A hive is two to six bees, each with its own focus, that read code, run commands and browse; bees never edit, the main model makes the change. Each time a bee finishes saying something, Jev judges once: is there anything here worth sharing, and is it a finding, a dead end, a decision or a blocker? What is worth it goes on a shared board. For each new note on the board, Jev judges once more per other bee: is this related to its focus? If so, the note is delivered to it, marked "a finding, not an instruction".

The board only grows, so a later conclusion can overturn an earlier one: a bee first says the tests will not run, then clears an environment variable and they do. Jev reads the relation between two notes (supersedes, contradicts, supports). A superseded conclusion becomes a correction, delivered to every bee that holds the old one; two notes that contradict each other both stay, marked as a dispute, and if nobody settles it within a minute a verifying bee is sent to find out.

<p align="center"><img src="docs/readme/swarm.png" width="960" alt="The desktop app's hive tab: what four bees are doing, the map of connections between them, and each delivery's words"></p>

The desktop app's hive tab is where all of this happens. One row per bee: its role, its model, what it is doing or has just said. The map draws who delivered a finding to whom: the more went along a line, the thicker it is; corrections and disputes have their own marks; a finding lights its line the moment it arrives. The flow lists every delivery's words, and the judgments list every verdict Jev gave. The hive card in the conversation carries the map in miniature and opens this tab.

A real run: three bees, nine minutes, Jev judged 117 candidates, 27 went on the board, 16 were delivered to the bee that needed them. Every verdict is written to the run's log, so it can be reviewed afterwards.

`/swarm` shows what each bee is doing right now, `/swarm stop` asks them to report now, `/swarm kill` ends them at once. A bee out of time is asked for its report and ended if none comes; a stuck model or tool is handled by the watchdog. A hive always returns.

## The plain-language board

Someone who does not read code can still tell how far the agent has got. Turn the board on (`/board`, or the switch at the top of the desktop app's board tab), and every few steps it says three things in plain words: what is happening now, how many items on the checklist are done, and what waits on you; below, every earlier update stays in order. When a run ends, the board sums it up.

<p align="center"><img src="docs/readme/board.png" width="960" alt="The desktop app's plain-language board: how far the work is, what is happening now, what happened before; context use and cache hit rate at the top"></p>

These words are not an abbreviation of what the model said. Jev picks out, from the verdicts and the events, the few that are actually news, and a model that explains well tells them; the board follows the permission mode, the goal and the sub-agents, and when the agent changes course, so does the wording. The two numbers at the top are how much of the context is in use and the cache hit rate: the result of the calls Jev makes about context and cache, and your measure of how much further this turn can go.

## Also

- **Three permission modes.** Full access, Jev approves, minimal; switch any time from the composer.
- **Goals.** `/goal <condition>` keeps the agent working until the condition holds; `/goal clear` ends it.
- **Lessons.** Append-only, editable, retirable; shared between the command line and the desktop app.
- **Subscription sign-in.** ChatGPT, Claude, Grok, and Google sign-in for Gemini CLI / Antigravity, inside the app.
- **Conversations you bring along.** Claude Code and Codex CLI conversations can be imported and continued.
- **Built-in browser, background jobs, MCP.** The agent works through a browser one step at a time; dev servers and long builds run in the background; MCP servers start when needed.

## Commands

Type `/` in the composer; in the desktop app the command palette (⌘K) finds them too.

| Command | What it does |
| --- | --- |
| `/goal <condition>` | Keep working until the condition holds |
| `/permissions` | Full access / Jev approves / minimal |
| `/board` | Turn the plain-language board on or off |
| `/remember`, `/lessons`, `/forget` | Keep a lesson, list the lessons, retire one |
| `/review`, `/commit` | Review the change with findings ranked by severity; write the commits |
| `/checkpoints`, `/rewind` | List the checkpoints; go back to one |
| `/agents`, `/swarm` | Send sub-agents; watch every one at work |
| `/browse`, `/jobs` | The built-in browser; background jobs |
| `/import` | Import a Claude Code or Codex conversation |
| `/doctor` | Check the setup and the connections |

## Privacy

Keys stay on this machine, in `~/.mu`. mu never downloads a model or a runtime for you: anything that needs a download asks first. Jev sees only the pieces a verdict needs.

## Development

```bash
npm install --ignore-scripts   # dependencies, without lifecycle scripts
npm run check                  # formatting, lint, types
./test.sh                      # tests (the ones that need a model are skipped without a key)
```

The desktop app is in `desktop/`: `bun install`, then `KYRN_ROOT="$(cd .. && pwd)" bun run start` runs the development build against the mu in this repository (run `npm install` at the root first). The repository layout and the contribution rules are in [AGENTS.md](AGENTS.md).

## Credits and license

mu is built on [pi](https://github.com/earendil-works/pi) (the coding agent, MIT; the root [LICENSE](LICENSE) covers `packages/` and `kyrn/`) and [AionUi](https://github.com/iOfficeAI/AionUi) (the desktop app, Apache 2.0; `desktop/` keeps its [LICENSE](desktop/LICENSE)). We are grateful to both. Third-party code in the judgment layer is listed in [THIRD_PARTY_NOTICES.md](packages/kyrn-judge/THIRD_PARTY_NOTICES.md).
