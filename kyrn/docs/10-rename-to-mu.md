# KYRN 更名为 mu

更新日期：2026-09-22。状态：**第一阶段的 harness 部分已完成并验证；桌面端和数据迁移尚未开始。**

新名 **mu**，终端命令 `mu`，视觉标识 **μ**。μ 一律用 U+03BC（希腊字母 mu），不用 U+00B5（微符号，Mac 上 Option+M 打出来的是它）。所有标识符只用 ASCII 的 `mu`。中文标语“见微知著”：μ 在单位前缀里就是“微”。

本轮只改名，没有功能改动。

## 1. 改了什么，没改什么

### 用户看得见的（已改）

| 项目 | 旧 | 新 | 旧名还能用吗 |
| --- | --- | --- | --- |
| 终端命令 | `kyrn` | `mu`（`kyrn/bin/mu`，`mu link` 建 `~/.local/bin/mu`） | 能。`kyrn/bin/kyrn` 和 `kyrn-dev` 转发到 `mu`，`~/.local/bin/kyrn` 旧链接照常工作 |
| 会话内命令 | `/kyrn …` | `/mu …` | 不能，直接换了 |
| 欢迎页 | 方块字 KYRN | 方块画的 μ + “mu · judgment-first coding agent” + “见微知著” | — |
| 终端标题 | `kyrn - <目录>` | `μ - <目录>` | — |
| 模型看到的身份 | “This harness is KYRN …” | “This harness is mu (written μ) …”，系统提示里的段名也由 `kyrn` 改为 `mu` | 旧会话续聊时系统提示会变一次，缓存前缀失效一次，属预期 |
| 上下文里的标记 | `[kyrn: omitted …]` 等 | `[mu: omitted …]` | 旧会话里已写下的标记保持原样；没有代码回读这些标记 |
| 技能 | `kyrn-browser` | `mu-browser` | — |
| 配置文件 | `<agent>/kyrn.json` | `<agent>/mu.json` | 能。没有 `mu.json` 时读 `kyrn.json`。`mu.json` 存在但损坏时报错，不回退，免得悄悄带回旧设置 |
| 环境变量 | `KYRN_*` | `MU_*` | 能。新名未设置或为空时读旧名 |
| 数据目录 | `~/.kyrn` | `~/.mu` | 能。见第 3 节 |
| 经验库 | `<agent>/kyrn/lessons.jsonl` | `<agent>/mu/lessons.jsonl` | 磁盘上本来就没有这个目录，直接改 |

同时认新旧两种拼写的环境变量：`JUDGE`、`JUDGE_MODE`、`WRITER`、`CHROME`、`AGENT_DIR`、`CODING_AGENT_DIR`、`APP_DIR`、`LINK_DIR`、`SESSIONS_DIR`、`LOCAL_JUDGE_URL`、`LOCAL_JUDGE_PORT`、`LOCAL_JUDGE_MODEL`、`LOCAL_JUDGE_RUN_DIR`、`LOCAL_JUDGE_MIN_LENGTH`。实现：TypeScript 里是 `packages/kyrn-judge/src/naming.ts` 的 `muEnv()`，脚本里各自内联同样的规则。仓库根的 `.env` 没有读、没有改，里面的旧变量名继续有效。

### 刻意不改的

| 保留项 | 原因 |
| --- | --- |
| 仓库文件夹 `KYRN`、`KYRN-desktop` | pi 的会话按工作目录归档（`--Users-baihe-Documents-KYRN--`），桌面端的 `KYRN_ROOT` 默认指向 `../KYRN`，git worktree、`~/.local/bin` 的链接和 Claude 的项目记忆都记着这个路径 |
| 会话和桌面事件里已存的类型名：`kyrn.decision`、`kyrn.verdict`、`kyrn.hint`、`kyrn.notice`、`kyrn.steer`、`kyrn.nudge`、`kyrn.monitor`、`kyrn.skills`、`kyrn.lessons`、`kyrn.hive`、`kyrn.swarm`、`kyrn.forgetting.state`、`kyrn.presentation.v1`，以及压缩记录里的 `details.kyrn` | 旧会话必须照常工作：压缩靠 `startsWith("kyrn.")` 把自家消息排除在外（漏进去会被当成 “[User]” 文本），遗忘状态靠类型名恢复，判定行靠类型名渲染，`mu ledger` 和回测脚本靠它读决策，桌面端靠它识别事件。`test/naming.test.ts` 把这些名字钉死了 |
| 两个仓库之间的其他约定：临时目录名 `kyrn-hive-*`、`kyrn-swarm-*`（桌面端用正则校验）、事件类型 `kyrn_rpc_closed`、父子进程之间的 `KYRN_SWARM_*`、`KYRN_HIVE_*` | 只改一边，另一边会不报错地丢数据 |
| 启动器生成的 `<数据目录>/app/package.json` 里的 `name: @earendil-works/pi-coding-agent` | pi 的自更新按这个包名装包，而 npm 上的 `mu` 是别人的包 |
| 包名 `@kyrn/judge`、目录 `packages/kyrn-judge` 和 `kyrn/`、脚本文件名 `kyrn-doctor` 等、类型名 `KyrnRuntime` 等、页面里的 `window.__kyrnBrowser` | 第二阶段（可选）。纯内部名字，用户看不见 |

## 2. 启动器

- `piConfig` 改为 `{ name: "mu", configDir: ".mu" }`。**pi 只读 `<应用名大写>_CODING_AGENT_DIR`**，改名后就是 `MU_CODING_AGENT_DIR`，旧的 `KYRN_CODING_AGENT_DIR` 和 `PI_CODING_AGENT_DIR` 它都不再看。所以启动器必须导出新变量，否则 pi 会悄悄落到 `~/.mu/agent` 的空目录里。现在三个名字一起导出。
- 应用视图（`<数据目录>/app`）原来只在上游 `package.json` 更新（按 mtime）时重建；现在 `piConfig` 对不上也重建。视图仍放在仓库外面：放进仓库，biome 会跳过真实源码。
- `mu link`：`MU_LINK_DIR`（或 `~/.local/bin`）下已有不是自己的 `mu`，或者 PATH 上已有别的 `mu`（Homebrew 的 maildir-utils 就叫 `mu`），都只提示、不链接；`mu link --force` 才会抢在前面。本机目前 PATH 上没有别的 `mu`。

## 3. 数据目录：先能用，再迁移

代码合并和数据迁移是两步，中间不能坏。规则只有一条，三处实现一致（`naming.ts` 的 `muHome()`、启动器、`kyrn-judge-local` / `kyrn-doctor` / `kyrn-ledger`）：

> `~/.mu` 存在就用它；否则 `~/.kyrn` 存在就继续用 `~/.kyrn`；两个都没有（新机器）才用 `~/.mu`。

关键在于：迁移之前，任何代码都不会在 `~/.kyrn` 旁边建出一个 `~/.mu`。两个数据目录并存意味着两份登录、两份会话列表、两个浏览器配置。

迁移步骤（**尚未执行**，需要用户明确同意，且没有 mu、桌面端、本地判定服务在运行）：

1. `mu judge stop`（本地判定服务的 pid 和日志在数据目录里）。
2. 确认 `~/.mu` 不存在；存在就停下来问，不合并、不覆盖。
3. `mv ~/.kyrn ~/.mu`（约 315 MB）。
4. `mv ~/.mu/agent/kyrn.json ~/.mu/agent/mu.json`。
5. 删除 `~/.mu/app`（里面只有指向仓库的软链和一个 `package.json`），让启动器重建。
6. `ln -s ~/.mu ~/.kyrn`：桌面端 11 个会话映射文件里存的是 `…/.kyrn/agent/sessions/…` 的绝对路径，这个软链兜住它们。
7. `auth.json`、`models-store.json` 全程不打开、不打印、不复制。

## 4. 验证

已验证（在隔离工作树分支上，Node 24）：

- `npm run check` 通过。
- `packages/kyrn-judge` 全部 24 个测试文件、204 个用例通过，其中为改名新增 11 个：
  - `test/naming.test.ts`：`MU_*` 优先、`KYRN_*` 兜底、空值不遮蔽；`mu.json` 优先、`kyrn.json` 兜底、损坏的 `mu.json` 报错不回退；数据目录三种情况；`MU_CHROME` / `KYRN_CHROME`；已存类型名不变。
  - `test/launcher.test.ts`（真实执行启动器，临时 HOME）：旧命令名转发；`link` 遇到别的 `mu` 不覆盖、不遮蔽；`piConfig` 对不上时重建视图且包名不变；未迁移的机器留在 `~/.kyrn` 且不创建 `~/.mu`。
- 旧的 `kyrn.*` 条目照常被压缩过滤、遗忘状态能恢复、判定行能渲染：这些行为的既有测试（`compaction.test.ts`、`forgetting.test.ts`、`preflight-view.test.ts`）原样通过，因为类型名没动。
- 欢迎页在 20～140 列宽度下不超宽、边框闭合（既有宽度测试）。μ 用方块字符画出来而不是直接打字：U+03BC 属于 East Asian Ambiguous 宽度，终端把它渲染成两格时会把右边框顶出去。字母本身只出现在终端标题里，那里没有边框要对齐。

尚未验证：

- 真实机器上的 `mu doctor`、`mu judge status`、TUI 欢迎页与标题、`/mu`、`mu -c` 续旧会话、`mu ledger` 读旧决策、非交互运行、内置浏览器配置仍在。这些要等合并进主检出并完成数据迁移后做。
- 桌面端的全部改动（见下）。

## 5. 还没做的

1. **桌面端**（等桌面仓库的现状先提交）：
   - 先修“按显示名找注册”的问题。AionCore v0.2.2 有 `PUT /api/agents/custom/{id}`，可以原地改名；注意它是整体替换（漏传的图标、描述、参数、环境变量会被清空），并且会先探活，探活失败会挡住启动。按 command 找到已有注册，同时认旧名 `KYRN`，绝不重复注册。`product.ts` 和 `scripts/kyrn/register.mjs` 两处要一致。
   - 13 种语言各 3 句界面文字、窗口标题、侧栏品牌字、注册描述；`settings.ts` 改为写 `mu.json`、读时认旧名，凭据变量白名单同时接受 `MU_JUDGE_*`；`~/.kyrn/acp-sessions` 与 `~/.kyrn/agent` 的路径改用同一条数据目录规则。i18n 键名 `kyrn.*`、IPC 通道名、目录名不动。
2. **数据迁移**（第 3 节）。
3. **实机冒烟**（第 4 节“尚未验证”）。
4. **第二阶段**（可选）：包名、目录名、类型名、脚本文件名、桌面端模块名、git 分支名。第一阶段验收后再定。
