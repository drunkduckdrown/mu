# Codes for translating what the desktop shows

The harness writes its presentation events in English. For a client that shows them in another language, each English sentence a person reads also has a stable code beside it, plus `params` holding what the sentence names (a count, a label, a tool). The client translates by code and falls back to the English when a code is missing or unknown. Existing fields never change meaning. Codes are only ever added.

Model-facing text (hints, tool results), paths, URLs, commands, the user's own words and model-written text have no codes. They are data and are shown as they are.

The language the person reads mu in is `MU_LANG` (see `src/language.ts`). With it set to Chinese, several user-facing strings (goal mode, /commit, the guard, permissions, the board) are already written in Chinese by the harness itself. The codes below cover the rest.

## The `/` menu

The command list (`get_commands` in RPC) is worded by `MU_LANG` when mu starts. It has no codes, because a description is only shown in the menu.

- **mu's own commands.** Every description is written in Chinese and in English. The Chinese is used when `MU_LANG` is Chinese, and English for every other language. `/help` follows the same rule. A test fails if a command is added without its Chinese.
- **mu's prompt templates** (`/implement`, `/scout-and-plan`, `/implement-and-review`, `/init`). Each template carries `description-zh` and `argument-hint-zh` beside its English. For Chinese, pi gets a copy of the templates with the Chinese in place. The copy is written to the system temp folder and named by its content, so an updated template is copied again. The body, which the model reads, is the same in both languages.
- **Skills** (`skill:…`). Their descriptions are what the model reads to decide whether to load one, so they stay in English.
- **pi's built-in commands** (`/model`, `/login`, `/new`, …). They are not in `get_commands`, which lists only extension commands, prompt templates and skills. Any menu entry the app shows for them uses the app's own wording.

A running process keeps its language. Switching the app's language takes effect in conversations started after the switch.

## browser.run

### state: failed

The run never started. Before this batch, nothing was sent at all.

- `code: "launch_failed"`: the browser could not be started or reached. `{ state: "failed", url, code, launchCode?, params?, reason, embedded: false }`
- `code: "open_failed"`: the browser is there, but the page would not open in it (an address it refuses, the app's panel busy with another run). `{ state: "failed", url, code, reason, embedded }`, where `embedded` says whether it was the app's panel. Its half-opened tab is closed again.

The launch codes:

| launchCode | params | English |
| --- | --- | --- |
| `no_browser` | `platform`, `wsl` (0/1) | no Chrome, Chromium, Edge or Brave found (plus install advice) |
| `windows_browser_unusable` | `executable` | a Windows browser cannot be used from WSL (networking mode) |
| `profile_no_windows_path` | `profileDir` | the profile folder has no Windows spelling |
| `browser_spawn_failed` | `command` | the browser could not be started |
| `browser_exited_on_start` | `exitCode` | Chrome exited during startup |
| `devtools_port_timeout` | | Chrome did not open its DevTools port in time |
| `cdp_connect_timeout` | | timed out connecting to the browser |
| `cdp_connect_failed` | | could not connect to the browser |

### state: finished

`{ state: "finished", status, code, params?, errorCode?, errorParams?, reason?, embedded }`. The embedded browser's `Mu.run` report carries the same `code`, `params`, `errorCode` and `errorParams`.

| code | params | English |
| --- | --- | --- |
| `done` | | (no reason) |
| `read` | | a page was read without a goal |
| `cancelled` | | the tool call was cancelled |
| `stopped_by_user` | | stopped by the person watching |
| `max_steps` | `maxSteps` | stopped after N actions |
| `no_judge` | `judgeReason` (a decision reason, see below) | no judge could choose an action (…) |
| `no_progress` | | the judge found no operation that makes progress |
| `not_confirmed` | `label` | "…" looks irreversible and was not confirmed |
| `no_value` | `label` | no value could be produced for "…" |
| `stuck` | `actions` | three actions in a row changed nothing |
| `error` | | the run threw; `reason` is the error message, and `errorCode` / `errorParams` say what it was when the error carries a code. None does today: a browser that will not start never gets this far (it is `state: "failed"` above) |

## progress

`{ step, code?, params? }`

| code | params | English step |
| --- | --- | --- |
| `frame` | | updating the task frame |
| `lessons` | | checking lessons from earlier sessions |
| `skills` | | choosing which skills this session needs |
| `capabilities` | | choosing which capabilities this task needs |
| `permission_review` | `summary` (a command or path, data) | Jev is reviewing: … (already localized) |

## decision (the judge's reason)

`decision.reason` is itself a stable code:

| code | meaning |
| --- | --- |
| `shadow` | the judge answered, but only for the record |
| `abstain` | the judge's answers were not decisive enough |
| `error:<kind>` | the judge call failed. `<kind>` is `timeout`, `aborted`, `unreachable`, `auth`, `payment_required`, `rate_limited`, `bad_request`, `server`, `invalid_response` or `unexpected` |
| `error:all` | every item of a batch failed |

`off` never reaches a `decision` event, because a decision that is switched off is not recorded. It only shows up in `preflight.verdict`.

## preflight.verdict

These fields are added to `VerdictData`:

- `reasonCode`, when there is no verdict: the decision's own reason (table above, plus `off`), or `skipped` (the person pressed esc) / `no_answer` with `reasonParams: { seconds }`. Those last two are only drawn in the terminal's panel: the event itself is sent only once a decision exists.
- `hintIds`, the same order as `hints`. None of them tells the model to stop and ask: the user is the resolver of last resort.
  - `answered`: the agent's last turn stopped to ask and this message is the reply; act on it, do not ask again (a rule, sent with or without a verdict)
  - `resolve`: the request is loosely worded and may change files; look at the workspace, say the assumption, ask only for what cannot be found here
  - `side_question`: answer briefly, then carry on with the main task
  - `plan_first`: large or risky; plan aloud, carry it out, pause only before a step that cannot be undone
  - `try_hive`: hard; use the hive if a direct attempt fails
  - `try_delegate`: independent parts; consider delegate
- `answerValues`, the judge's answers by question id, as it gave them:
  - `{ type: "boolean", probability }`
  - `{ type: "choice", choice, probabilities? }`
  - `{ type: "score", score, probabilities? }`

  The question ids are `turn_type`, `is_side_question`, `needs_clarification`, `needs_files_changed`, `needs_memory`, `swarm_worthy`, `plan_first`, `task_complexity`, `reasoning_depth` and `tool_complexity`.

## Sub-agents (delegate and hive snapshots)

These appear in the swarm snapshot the tool streams (`details.snapshot.bees[]`).

`recent[]`, one entry per activity line: `{ at, text, code?, params? }`

| code | params | English |
| --- | --- | --- |
| `notes_received` | `count` | ← N notes from the others |
| `late_notes` | `count` | ← last call: N late notes |
| `asked_findings` | | ← asked what it has found so far |
| `told_wrap_up` | | ← told to wrap up and report |
| `tool_call` | `tool`, `summary` (data) | the call, summed up |
| `tool_failed` | `tool` | <tool> failed |
| `retry` | `attempt`, `maxAttempts`, `message` (data) | retry a/m: … |
| `model_error` | `message` (data) | model error: … |
| `compacting` | | compacting its context |

Next to `error`, the bee carries `errorCode` and `errorParams`. The same codes appear as `wrapUp.code` and `wrapUp.params`.

| code | params | English |
| --- | --- | --- |
| `cancelled` | | the run was cancelled |
| `stopped_by_user` | | stopped by the user (`/swarm stop`) |
| `ended_by_user` | | ended by the user (`/swarm kill`) |
| `stalled` | `what` (`model` or `tool`), `tool?`, `seconds` | no sign of life from … for … |
| `time_budget` | `minutes` | time budget of N min reached (a wrap-up) |
| `no_report_in_time` | `seconds`, `after?` (the wrap-up's code) | …; no report within Ns of being asked |
| `model_error` | `message` (data), `stopReason` | the model request failed |
| `retries_exhausted` | `message` (data) | the model request kept failing |
| `exited_early` | `exitCode`, or `signal` when it was killed | sub-agent exited with code N (or was ended by SIGTERM) before it finished |
| `chain_broken` | `step` | not started: the step before it (…) did not finish |
| `error` | `message` (data) | any other failure |

The run's own title (`details.snapshot.title`) has `titleCode`, an object unlike the other `*Code` fields: `{ code: "delegate_tasks" | "delegate_chain", params: { count } }`. A hive's title is its goal, which is text to show as it is, and has no `titleCode`.

Before the first snapshot, the delegate tool's partial update carries `details: { code: "choosing_roles", params: { count } }`, next to "choosing a role, a model and a thinking level for N sub-agents…".

## goal.state

`reasonCode` and `reasonParams` are set only while the goal is paused. `reason` is already in Chinese or English. When `reason` is the checking model's own words, there is no code.

| code | params | zh / en |
| --- | --- | --- |
| `interrupted` | | 你打断了这次运行 / you interrupted the run |
| `model_call_failed` | | 一次模型调用失败了 / a model call failed |
| `needs_user` | `detail?` (model text) | 代理在等你回复 / the agent needs something from you |
| `unjudged` | | 没有判定器能读出目标是否达成… / no judge could read whether the goal holds… |
| `idle` | `runs` | 代理连续 N 次什么都没做就停下了 / the agent ended N runs in a row without doing anything |
| `no_progress` | `runs`, `detail?` | 连续 N 次没有进展 / no progress in N runs in a row |
| `continuations_used_up` | `max` | 续跑次数（N 次）用完了 / the allowance of N continuations is used up |
| `minutes_used_up` | `minutes` | 时间额度（N 分钟）用完了 / the allowance of N minutes is used up |
| `session_reopened` | | 会话重新打开了 / the session was reopened |

## board.update

Only the updates with `by: "rules"` are fixed sentences.

- `progress` is rebuilt from `done` and `total`: none yet, all done, or N of M done.
- `now` is rebuilt from `phase` (the table in plain-language-board.md) plus `focusText`, the text of the item being worked on, which is new.
- `confirmCodes` holds one entry per `confirm` line: `waiting_reply` ("It waits for your reply."), or `null` for a line quoted from the agent.

## frame.updated

`openQuestionCodes` holds one entry per `frame.openQuestions` item:

- `{ code: "unclear_change", params: { message } }` for the rules' question "How does this change the task: "…"?"
- `null` for a question the writer model wrote, which is its own words.

## permissions.request

These fields are added:

- `flagCode`, for a flagged command: `recursive_or_forced_delete`, `discards_git_work`, `force_push`, `drops_database_objects`, `overwrites_device`, `opens_permissions_recursively`, `runs_downloaded_script`, `runs_as_administrator` or `runs_as_root`.
- `answerIds`, in the order of `answers`: `once`, `session` (when offered) and `deny`. These are the same ids `permissions.resolved` reports.

The mode labels and descriptions are already in Chinese or English. Key your own strings on `mode` and `modes[].id`.

## web.search

`problemCodes` holds one entry per `problems` item, in the same order:

| code | params |
| --- | --- |
| `source_not_configured` | `source` |
| `source_failed` | `source`, `message` (data) |
| `source_robot_page` | `source` |
| `source_http_error` | `source`, `status` |
| `source_no_results` | `source` |
| `source_unrelated` | `source` |

## mcp.failed

`code` and `params?` sit beside `reason`. `reason` keeps the server's own last words, redacted.

| code | when |
| --- | --- |
| `project_untrusted` | a project-defined server in an untrusted folder |
| `needs_approval` {source} | a project-defined server not yet approved, and nobody to ask |
| `denied` | the person said no to starting it |
| `unreachable`, `closed`, `timeout`, `aborted`, `rpc`, `protocol` | the start failed (the MCP client's own kinds) |
| `start_failed` | the start failed some other way |
| `crashed` {willRestart} | it crashed while running (`willRestart` is also a field) |
| `restart_failed` {cause} | the restart after a crash failed too. Before this batch, nothing was sent. |

A server that dies during its start now sends one `mcp.failed` (its start failure). It no longer sends a `crashed` / `willRestart: true` event first, and that no longer uses up its one restart.

## rewind.proposed

`triggerCode` and `triggerParams` sit beside `trigger`:

- `same_command_failed`: `{ times, command }`, where `command` is data
- `monitor_trouble`: `{ times, kind, detail }`, where `detail` is data
