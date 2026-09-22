# Permission modes

How much mu may do without asking. There are three modes, and you can switch between them at any time with `/permissions`.

| mode | id | what runs without asking | what asks |
| --- | --- | --- | --- |
| 完全访问 / Full access | `full` | everything | nothing |
| JeV 审批 / JeV approves | `jev` | reading; editing files inside the project; whatever JeV is sure the task needs | whatever JeV is not sure of, thinks goes beyond the request, or thinks is unrelated |
| 最小权限 / Minimal permissions | `ask` | reading only | every edit, command, outside action and sub-agent |

Some things hold in every mode:

- **Hard constraints still apply.** What you said not to do is stopped by the constraint gate, even in full access. That gate is about your words, not about permission.
- **Reading is never asked about.** This covers `read`, `grep`, `find`, `ls`, `todo`, `web_search`, `web_fetch`, background output, `sg_search`, the debugger's inspect/step/stop, and shell commands made only of read-only programs (`git status`, `cat … | grep … | head`).
- **Unlisted tools are asked about.** A tool mu does not know (an MCP tool, for example) needs permission. A command counts as read-only only when every part of it is on the short read-only list.
- **mu's own settings are always yours to decide.** Any call that touches the agent folder (`~/.mu/agent`, spelled as a path, with `~` or with `$HOME`) is asked every time. JeV cannot approve it, and "allow for this conversation" is not offered.

## What JeV is asked

JeV mode puts one choice question, `tool.approval`, to JeV: what is `tool_call` for `task` and `user_message`? The answer is `needed`, `beyond`, `unrelated` or `unclear`.

- Only `needed` at probability 0.8 or higher runs without you.
- Anything else asks you, and the prompt says why ("JeV thinks this goes beyond what you asked for").
- If there is no verdict at all (the judge is down, or its mode is `off`), you are asked.

JeV's verdict counts even when the decision's own mode is `shadow`, because choosing JeV mode is the opt-in.

Commands that the risk rules flag work differently: `rm -rf`, force push, `sudo`, running a downloaded script and the rest of the guard's rules. In JeV mode they use the guard's `tool.risk` question and run only when JeV is sure you asked for them. In minimal mode the flag is shown in the question. A flagged command can only be allowed once, never for the whole conversation.

With permission modes on (the default), they take over the old guard. With `features.permissions: false` in mu.json, the guard works on its own as before.

## Asking

A call that needs you shows one picker with fixed answers:

- `Allow once` / 允许这一次
- `Allow for this conversation（<scope>）` / 这次对话都允许（<scope>）. This is offered only when the call has a safe scope.
- `Don't allow` / 不允许

While the picker waits, the status line `mu.permissions.pending` says "Waiting for your permission: <summary>" / "等你授权：<summary>". It is cleared once you answer. The mode itself is always shown in the status line `mu.permissions` ("Permissions: JeV approves" / "权限：JeV 审批").

"For this conversation" covers:

| call | scope |
| --- | --- |
| edits inside the project | all of them |
| a command | its program, plus the sub-command for `git`/`npm`/`pnpm`/`yarn`/`cargo`/`docker`/… (`npm test`, `git commit`) |
| a command with chaining, redirection or substitution, or starting with `VAR=`, `sudo`, `env`, `bash -c`, … | nothing: once only |
| an edit outside the project | that file |
| another tool | that tool |

Allowances are forgotten when you switch mode or run `/permissions reset`.

Esc while the picker is open counts as "Don't allow". A refusal reaches the model as: "The user did not allow this (…). Do not try another way around it: ask them, or carry on without it."

When nobody can be asked (print mode, a sub-agent), a call that would ask is refused, and the reason tells the model to report what it needed.

## Where the mode comes from

When a conversation starts:

1. If the conversation was switched before, it keeps that mode (from a `mu.permissions` session entry), including when it is reopened.
2. Otherwise `MU_PERMISSIONS` (or `KYRN_PERMISSIONS`) applies. Sub-agents get their parent's current mode this way.
3. Otherwise the mode last chosen with `/permissions` applies, read from `<agentDir>/mu/permissions.json` (`{"version":1,"mode":"ask"}`, mode 600).
4. Otherwise `features.permissions.mode` in mu.json applies, which defaults to `jev`.

`/permissions <mode>` switches this conversation, writes the session entry, saves the new default for later conversations, and forgets allowances. Other running conversations keep their own mode.

## Commands

- `/permissions`: a picker of the three modes with descriptions. Without a UI, it prints the current mode.
- `/permissions full | jev | ask`: switch. `yolo`, `auto`, `minimal`, `read-only`, `完全访问`, `审批` and `最小权限` also work.
- `/permissions reset`: forget what was allowed for this conversation.

## Presentation events (for the desktop)

| kind | payload | when |
| --- | --- | --- |
| `permissions.mode` | `{ mode, label, modes: [{ id, label, description }] }` | at session start and on every switch |
| `permissions.request` | `{ id, mode, tool, kind, summary, reason, flag?, grant?: { key, label }, answers: string[] }` | right before the picker opens |
| `permissions.resolved` | `{ id, answer: "once" \| "session" \| "deny" }` | once the picker is answered |
| `permissions.approved` | `{ tool, kind, summary, by: "jev" \| "grant" }` | a call that needed permission ran without asking you |

- `kind` is one of `edit`, `shell`, `run`, `outside`, `delegate` or `other`.
- `reason` is one of `ask` (minimal mode), `unsure`, `beyond`, `unrelated`, `flagged` or `protected`.
- `answers` holds the exact option strings the picker offers, in order. The picker is the normal extension `select` dialog (over RPC, `extension_ui_request` with `method: "select"`), so the desktop answers it with the chosen string.
- To switch modes, send `/permissions <id>` as a typed command.
