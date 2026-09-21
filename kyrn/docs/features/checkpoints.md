# 检查点与判断回退（`/checkpoints`、`/rewind`、`turn.rewind`）

更新日期：2026-09-22。代码：`packages/kyrn-judge/src/checkpoint/git.ts`（跑 git）、`src/checkpoint/store.ts`（快照与还原，纯函数）、`src/checkpoint/mutating.ts`（哪些调用会改文件）、`src/decisions/turn-rewind.ts`、`src/extension/features/checkpoint.ts`（接线、命令、提议）。monitor 多了两行：发现打转或跑偏时告诉运行时（`runtime.trouble`）。

## 1. 要解决什么

一条路走进死胡同以后，最便宜的恢复不是在坏掉的路上继续打补丁，而是**回到走这条路之前**：文件回去，对话也回去，只留一句“试过什么、为什么放弃”，然后换一条路。pi 自带的示例 `git-checkpoint.ts` 用 `git stash create` 做这件事，它有三个问题：只在 git 仓库里能用；`stash apply` 会经过用户的 index；而且它只在 `/fork` 时问一句，没有人判断“该不该回”。mu 的做法：快照存在自己的影子仓库里，从不碰用户的仓库；回退由用户在命令里发起，或者由判定器在发现死路时**提议**。

## 2. 影子仓库：为什么用户的仓库永远不会被碰

每个项目一个影子 git 目录：`<mu 主目录>/mu/checkpoints/<项目路径 realpath 的 sha256 前 16 位>/`（`features.checkpoint.dir` 可改）。目录里是一个 `init --bare` 出来的仓库，外加：

- `mu-project.json`：项目路径和最近一次使用时间（清扫用）；
- `config` 追加一段：`autocrlf=false`、`safecrlf=false`、`longpaths=true`、`quotepath=false`、`fsmonitor=false`、`gc.auto=0`、`commit.gpgsign=false`、`hooksPath` 指向影子目录里一个不存在的子目录；
- `info/attributes`：`* -text -filter -ident -working-tree-encoding`，压过项目的 `.gitattributes`，于是不做行尾转换、不跑 clean/smudge 过滤器（LFS）、不改编码，还原就是逐字节还原；
- `info/exclude`：内置的忽略清单（`node_modules/`、`dist/`、`build/`、`target/`、`.venv/`、`coverage/`、`.next/` 等 28 条）加上用户在 `features.checkpoint.ignore` 里补的。

每条 git 命令都在同一套环境里跑：继承的环境先**去掉所有 `GIT_*` 变量**（在 git 钩子里启动的代理会带着指向真实 index 的 `GIT_INDEX_FILE`，一个漏网的变量就够把快照写进用户的 index），再设 `GIT_DIR=<影子>`、`GIT_WORK_TREE=<项目>`、`GIT_INDEX_FILE=<影子>/index`、固定的作者身份、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、`GIT_LITERAL_PATHSPECS=1`（`a[1].txt` 这样的文件名不当模式）。不经过 shell，参数数组直接 `spawn`。

所以：用户的 `.git`（index、HEAD、refs、stash、hooks）一个字节都不动；项目不是 git 仓库也一样能用；因为 git 从不把带 `.git` 的路径加进索引，用户仓库本身也不会被复制进快照。项目里嵌套的别人的仓库（`vendor/lib/.git`）在 `ls-files --others` 里显示为 `folder/`，直接跳过。

## 3. 什么时候拍快照

**每个会改文件的用户回合拍一次，拍在第一次会改文件的工具调用之前**（`tool_call` 事件里），只读的回合一次也不拍。哪些调用算“会改文件”（`mutating.ts`）：`read` / `grep` / `find` / `ls` / `find_skill` / `find_capability` / `locate` / `todo` / `browse` / `web_fetch` / `web_search` / `bg_output` 不算；`bash` 只有整条命令是 `ls`、`cat`、`git status`、`rg` 这类只读程序（可以用管道连接，但不能有重定向、`;`、`&&`、反引号、`$(`）才不算；其他一切工具（`edit`、`write`、`powershell`、任何 MCP 工具）都算。判错的方向只有一个：多拍一次。

一次快照 = `ls-files --others --modified --deleted --exclude-standard` 列出自上次以来变过的路径 → `update-index` 进影子索引（超过大小上限、读不了、变成目录的路径反而从索引里移除）→ `write-tree` → `commit-tree`，提交信息里带一段 JSON：当时存在但没进快照的路径（被忽略的、超大的、嵌套仓库），这是还原时判断“这个文件是不是那之后才创建的”的依据。引用名 `refs/mu/<会话 id>/<编号>`。会话里记一条 `kyrn.checkpoint` 条目 `{ id, turn, commit, entryId, label, at }`：`entryId` 是这个回合的用户消息，对话要回到它前面；条目跟着会话树走，分叉或回退之后 `/checkpoints` 只列当前分支上的。

代价：第一次要把整个项目读进影子索引，之后每次只看变过的文件。在本仓库（约 2000 个文件）上探测：首次 `add` 1.2 s，之后每次 50–150 ms（用 `add -A` + `write-tree` 量的，最终代码走的是等价的 `ls-files` + `update-index`）。超过 `timeoutMs`（默认 30 s）就放弃这一回合的快照，工具照常执行，界面上说一次。

## 4. `/checkpoints` 与 `/rewind`

| 命令 | 作用 |
| --- | --- |
| `/checkpoints` | 当前分支上的检查点，最新在前：编号、回合、时间、从那时起改了几个文件（快照已被清掉的标“pruned”）、那一回合的请求 |
| `/rewind` | 回到最近的检查点；先展示会发生什么，再问范围 |
| `/rewind 3` / `/rewind #3` | 回到 3 号 |
| `/rewind 3 files` / `conversation` / `both` | 直接指定范围，只剩一次确认 |
| `/rewind undo` | 撤销上一次回退 |

代理还在运行时 `/rewind` 会拒绝（先按 Esc 停下）；没有界面（print / json）时也拒绝，因为没有人能确认。

**先看再做。** 命令先算一份计划：哪些文件会**放回**（改过的）、哪些会**删除**（那之后创建的）、哪些会**找回**（那之后删掉的）、哪些**不动**并说明原因。删除只针对快照能证明当时不存在的文件：当时存在但被忽略或超大的文件，即使现在看起来“新”，也不删；快照里被忽略的路径超过 5000 条时干脆不记，这样的检查点从不删除任何东西。此外：被忽略或超大的文件永远不会被覆盖；现在是目录的地方不会被清掉去放文件（git 自己的强制检出会这么干，所以还原没有用它）；符号链接按符号链接还原；文件模式还原。

**手改的文件另问一次。** 运行时记着代理最后一次改动之后的树（`lastAgentTree`）。计划里的文件如果在那之后又变了，只可能是用户自己改的：命令会单独列出它们，问“保留这些文件 / 一起回退（现在拍的快照能找回来）/ 取消”。重新打开会话之后没有这个记录，那就把计划里的每个文件都当作可能是手改的，仍然问。

**每次回退前先拍一张快照**，这就是 `/rewind undo` 还原的东西；回退本身记成 `kyrn.rewound` 条目 `{ to, undo, fromLeaf, scope, by, at }`。撤销把文件还原到那张快照，对话（如果当时移动过）回到 `fromLeaf`。

**三种范围。** `both`：文件和对话；`files`：只还原文件，对话留在原地；`conversation`：只移动对话。

**留下的一句话。** 回退之后在新分支上发一条 `kyrn.rewind` 自定义消息：回到了几号检查点、那之前的请求是什么、“Tried: … / Abandoned because: …”（配置了 writer 模型时由它写两行；没有 writer 时是原因标签，例如“the user went back to this checkpoint”或触发它的事实）、改过的文件清单、“换一条路”。它是 `kyrn.` 前缀的消息，压缩会把它过滤掉。

## 5. 对话那一半：pi 的树 API 允许什么，不允许什么

查证结果（`packages/coding-agent/src/core/extensions/types.ts`、`core/agent-session.ts`、`docs/extensions.md`）：

- 移动叶子的 `ctx.navigateTree(entryId, { summarize })` **只在 `ExtensionCommandContext` 上有**，也就是只有 `registerCommand` 的处理函数拿得到；事件处理函数（`tool_call`、`turn_end`……）的 `ctx` 没有它。文档说明原因：在事件里调用会死锁。
- 它在代理正在运行、正在压缩、正在做分支摘要时**直接抛错**（不是返回 `cancelled`），所以哪怕在命令里也得先 `await ctx.waitForIdle()`。
- 目标是用户消息时，叶子落到它的**父节点**，消息文字放进编辑器（pi 的 `/tree` 行为）；目标是其他条目时叶子就是它。
- 它由宿主绑定：交互模式、RPC 模式、print 模式都绑了；没绑的宿主里调用它什么都不做且返回 `cancelled: false`，所以命令**核对叶子是否真的动了**，没动就明说：“对话没能从这里移动，还剩一步：`/tree`，选那条消息”。
- 之后 `session_tree` 事件照常发出，任务帧（`kyrn.frame`）和目标模式（`kyrn.goal`）从中恢复各自在那个分支上的状态，不需要这里做任何事。

于是用户发起的 `/rewind` 直接调用它。判定器的提议发生在运行中间（`turn_end`），那里既没有 `navigateTree` 也不允许移动，所以走一条绕路：用户点了“是”之后先还原文件，然后 `ctx.abort()` 停掉运行，再给自己发一条 `/rewind --resume <一次性令牌>`——pi 对扩展命令的处理是“即使在流式输出中也立刻执行”，命令里 `waitForIdle` → `navigateTree` → 写下条目和那句话 → 把原来的请求重新发出去，模型从请求和那句教训开始新一轮，旧尝试不在上下文里。等待期间的任何工具调用都被拦住（最多 60 s，超时自动放行，避免卡死）。这条绕路是必要的复杂度，不是可选的：要么如此，要么就只能还原文件、让用户自己 `/tree`。print / json 模式没有界面，也就没有人能确认：不动文件，只给模型一条 steer（第 6 节）。

## 6. 判定点 `turn.rewind`

什么时候问：同一回合里 monitor 第二次开口（打转或跑偏），或者同一条命令**失败满 3 次**。每个回合最多问 2 次、最多**提议 1 次**。状态很小：任务帧的目标、最近 12 步的一行摘要（`bash: npm test -> error`）、触发原因、这次检查点之后改了几处、最近一次测试/构建/检查命令有没有失败。

两个是非题（能力类别：`dead_end` 为 `classify`，`progress` 为 `relate`）：

- `dead_end`：Does `recent_steps` show the same approach failing again and again?
- `progress`：Does `recent_steps` show progress towards `goal`?

策略：`dead_end` 确信为是**且** `progress` 确信为否 → 提议；其他一切（包括拿不准）→ 继续。兜底 = 继续。**它只提议，从不回退**：

- `active` 且有界面：一个确认框，写明触发原因、会放回/删除/找回哪些文件、“之后模型从你的请求重新开始，附一句什么没做成；`/rewind undo` 可撤销”，默认等 120 s（`confirmSeconds`，0 为一直等）。同意 → 手改文件另问 → 第 5 节的流程；拒绝 → 什么都不动，这个回合不再提。
- `active` 但没有界面（print / json）：不动文件，给模型一条 steer：这条路像死胡同，退回去换一条。
- `shadow`：只记录判定；`off`：不问。判定器不可用：继续。

## 7. 清理与选项（`mu.json` 的 `features.checkpoint`）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `dir` | 空 | 影子仓库放哪，空 = `<mu 主目录>/mu/checkpoints` |
| `keep` | 50 | 每个项目保留的快照数 |
| `maxAgeDays` | 14 | 快照保留天数；也是整个影子仓库多久没用就清掉的天数 |
| `maxFileMb` | 5 | 更大的文件不进快照，回退也不碰 |
| `ignore` | `[]` | 额外的 gitignore 规则 |
| `timeoutMs` | 30000 | 单条 git 命令最长用时 |
| `propose` | `true` | 发现死路时问判定器并提议 |
| `confirmSeconds` | 120 | 提议等待回答的时间 |

会话启动时清掉 `maxAgeDays` 没用过的项目影子仓库（只认带 `mu-project.json` 的目录）；一个项目在本会话第一次拍快照时，删掉超过 `keep` 或超过 `maxAgeDays` 的引用，有删除时在后台 `gc --prune=3.days.ago` 回收对象。影子目录里 120 s 以上的 `*.lock` 和临时还原索引在打开时清掉（是死掉的进程留下的；新鲜的属于另一个会话正在跑的命令，不碰）；`session_shutdown` 等最多 3 s 让手上的命令跑完，再清锁，不留任何锁。子代理（`KYRN_SWARM_DEPTH`）不拍快照：父代理在 `delegate` 之前的检查点已经覆盖了它改的东西。

## 8. Windows

代码层面：`spawn` 不经 shell、`windowsHide`，`git.exe` 是真正的可执行文件，不涉及 `.cmd` 垫片；路径一律 `node:path`，快照里的 `/` 分隔路径回到磁盘时按平台拼接；影子配置带 `core.longpaths=true`；`hooksPath` 写成正斜杠并加引号；去掉 `GIT_*` 时忽略大小写（Windows 的环境变量不分大小写）；`autocrlf=false` + `-text` 属性保证 CRLF 文件逐字节往返（有测试）。符号链接的测试在 Windows 上跳过（需要开发者模式才能建链接）。**没有在 Windows 真机上跑过。**

## 9. 验证情况

22 个测试，git 不做模拟（git 2.49，macOS），全部用测试现建的真实临时目录，路径带空格和中文，不碰用户的任何仓库：

- `test/checkpoint-store.test.ts`（11 个）：非 git 目录里改/增/删的还原，连带清掉尝试新建的空目录；**用户仓库逐字节不变**——脏 index（暂存的改动、暂存的新文件、其上的未暂存改动）、stash、HEAD、refs、`git status --porcelain=v2`、`git diff --cached`、原始 index 文件的字节，还原前后全等，且在 `GIT_INDEX_FILE` 指向真实 index 的环境（钩子里启动）下也如此，用户的 `reference-transaction` 钩子没有跑；被忽略的、超大的、嵌套仓库里的文件既不被覆盖也不被删除，长大超过上限的文件不被旧内容替换；文件变目录时不清目录，`keep` 名单里的文件不动；符号链接、可执行位、CRLF 还原；按数量和天数裁剪；清扫只清自己的目录；陈旧锁清掉、新鲜锁保留；没有 git 时抛 `GitMissing`；环境变量清理与路径安全（`..`、绝对路径、`.git`、`GIT~1`、反斜杠一律拒绝）。
- `test/checkpoint.test.ts`（11 个，pi 测试 harness + faux 模型 + `MockJudgeProvider`，`only: ["preflight", "monitor", "checkpoint"]`）：只读回合不拍、改文件的回合在第一次改动前拍一次并记条目和展示事件；`/checkpoints`；`/rewind` 文件和对话一起回去、旧尝试离开上下文、请求回到编辑器、`kyrn.rewind` 那句话、`kyrn.rewound` 条目、`rewind.done` 事件，随后 `/rewind undo` 全部复原；手改文件被单独问到、按“保留”处理、`files` 范围下对话不动；宿主没绑 `navigateTree` 时只还原文件并说出那一步；判定为死路且用户同意 → 文件回去、运行停下、对话回到请求前、模型从请求和教训重新开始且看不到旧尝试的输出，展示事件顺序 `rewind.proposed` → `rewind.done`；用户拒绝 → 不动且本回合不再问；没有界面 → 不动文件，只给模型一条 steer；`shadow` 只记录（台账里 `judged: "propose"`、`outcome: "continue"`）、`off` 不问、判定拿不准不提议；没有 git 时工具照常、只提示一次、`/rewind` 说明关闭；`turn.rewind` 策略的四种组合与兜底；只读命令与检查命令的识别。
- 原有的 `features`、`extension`、`manifest` 测试通过；`npm run check` 通过。合并进 `claude/kyrn-test-log-admission-9a880d` 后整包 53 个文件 549 个测试通过（协调者报告）。

## 10. 未验证

- **Windows / WSL 真机**。
- **真实 Jev 对两个问题的校准**。阈值沿用 `threeZone` 默认（是 ≥ 0.8，否 ≤ 0.2）。已知 Jev 的布尔答案概率偏压缩（清楚的情况也只有 0.83–0.86 / 0.14–0.17），所以“确信”刚好够到，实际提议率可能偏低；需要真实会话的台账来调。
- **真实终端里的提议流程**（确认框 → `abort` → 自发的 `/rewind --resume` → 重发请求）只在 harness 里以脚本化的 RPC 式界面跑过，没有在 pi 的交互模式里亲眼看过；尤其是交互模式的 abort 处理（它会把队列里的消息放回编辑器）和这条绕路有没有互相干扰。
- monitor 第二次开口触发提议的那条路径没有专门的用例（用例都是“同一命令失败 3 次”触发）；writer 模型写两行教训的路径没有用例（只测了没有 writer 的写法）；被忽略路径超过 5000 条的溢出处理没有用例；后台 `gc` 没有用例。
- 两个会话同时开着同一个项目：共享一个影子索引，后来者的快照会撞上锁而放弃这一回合（提示一次）；只测了陈旧锁，没有真的开两个会话。
- 会话恢复（resume）之后 `/rewind` 依赖影子仓库里的提交还在；手改检测退化为“全部都问”。没有用例。
- 大仓库的耗时只有上面那次探测，没有系统测量；`timeoutMs` 到期后这一回合无快照的分支没有用例。

## 11. 留给用户拍板的

- **模型自己请求回退的工具**（原设想的 `rewind` 工具：`always` 能力，判定器像风险把关那样为它担保，担保不了就问用户，没人可问就不执行）**没有做**。协调者把它移出了本包的范围；如果要做，判定点 `turn.rewind.vouch` 一个是非题（Does `recent_steps` show repeated failed attempts?）加一个工具就够，其余流程与第 5 节共用。
- 用户拒绝提议之后，这个回合不再问。要不要在下一次触发（比如又失败 3 次）时再问一次，还是整个会话只问一次？现在是“每回合最多一次提议”。
- 快照大小上限 5 MB、保留 50 份 / 14 天：是拍脑袋的默认值。
- 提议默认等 120 s：桌面端把确认框做成持久面板的话可以设 0。
- 那句教训是 `kyrn.` 前缀的消息，按约定 mu 自己的压缩会把它和其他每回合提示一起过滤掉。它是不是该比别的提示活得久（例如进任务帧的“未决问题”或项目级经验），是用户在 09-21 提过的方向（失败的尝试蒸馏成项目级经验），本包没有做。
