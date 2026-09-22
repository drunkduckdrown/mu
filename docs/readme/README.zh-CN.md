<p align="center">
  <img alt="μ" src="../../desktop/resources/app.png" width="112">
</p>

<h1 align="center">mu</h1>

<p align="center"><b>先想清楚、再动手的编程代理。</b><br>
日常的小判断交给一个又小又快的判定器，大模型把注意力留给真正的工作。</p>

<p align="center">
  <a href="../../README.md">English</a> · <b>简体中文</b> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

> **状态：早期开发中。** mu 的作者们每天都在用它，但这里的一切都还没有正式发布。名称、设置和文件格式仍可能变化。标为*实验性*的功能既没在真实账号上试过，也还没在各类真实机器上逐一试过；文档会准确写明哪些已经验证、哪些还没有。

---

## 为什么是 mu

一个编程代理的模型调用和上下文窗口，花在小问题上的比例高得出人意料。这条消息是新任务还是纠正？这条命令需要用户授权吗？4000 行的测试日志里哪一部分要紧？代理是不是在原地打转？这件活该交给哪个子代理、用哪个模型？浏览器下一步该点哪里？

mu 把这些问题交给一个**判定器**：一个快速的模型，用不到一秒的时间回答格式固定的是非题和选择题，再由代码按答案行事。读写你代码的主模型，只会看到它需要的内容。

- **每个判定都看得见。** 每个判定点都有一个模式：`off`（关闭）、`shadow`（影子：照常提问并记录，但不据此行动）或 `active`（生效）。判定结论和用时都会记进账本（`/ledger`、`mu ledger`）。
- **每个判定都有兜底。** 判定器拿不准、太慢或连不上时，改由一条简单规则决定，或者按 pi 原有的行为运行。
- **判定器可以替换。** mu 可以用 [JeV](../../kyrn/docs/08-jev-retrospective.md)（托管服务，经由 Vercel AI Gateway）、*Laya*（macOS 上的本地判定器，基于 Core ML）、你已经在用的任何语言模型，或者把其中几种分层组合：后一层判定器只接手前一层拿不准的问题。

mu 基于 [pi](https://github.com/earendil-works/pi) 构建，pi 是一个极简、可扩展的终端编程代理。mu 几乎不动 pi 的核心，判定层以扩展的形式加在上面（`packages/kyrn-judge`）。桌面应用基于 [AionUi](https://github.com/iOfficeAI/AionUi) 构建。

## 现在能做什么

**判定层**，32 项功能里共有 29 个判定点：

- **每条消息先读一遍。** 判定器判断这是哪一类回合（新任务、纠正、新的约束、顺带一问）、需要多深的思考、要不要先做计划。这期间消息停在编辑器上方等待（按 `esc` 可跳过等待），判定结论随后留在对话里这条消息的下方。
- **任务帧。** mu 记着目标、你的硬约束（用你的原话，并注明出处）、当前子目标和一份验收清单。每次改动之前，都会对照你的约束检查这次改动；明显违反的会被拦下，并引用你的原话。`/frame` 可以查看任务帧。
- **让上下文保持精简。** 测试日志里重复出现的失败只保留一份。工具、MCP 服务器、语言服务器和能力包都装着，但在任务需要之前一直隐藏（能力目录）。只报告新出现的编译错误（LSP 诊断与基线对比）。技能和经验按任务挑选。
- **三种权限模式。** *完全访问*；*JeV 审批*（任务明显需要的由判定器批准，其余的问你）；*最小权限*（除了读取，一律先问你）。用 `/permissions` 切换。某一步需要你批准时，状态栏会出现提示。
- **目标模式。** `/goal <condition>` 让代理一直工作，直到条件成立。每当代理想停下，都由一个语言模型阅读证据来判断。硬事实优先：只要验收清单里还有没勾掉的项，或者有改动没经过任何检查，就算还没完成。
- **人话看板。** 每隔几步，判定器挑出真正的新情况，再由一个擅长讲解的模型把它转述给不读代码的人：工作做到哪了、现在在做什么、哪些事在等你。一轮运行结束时，看板会做个总结。用 `/board on` 按项目开启。
- **检查点与回退。** 每个回合第一次改动之前，工作区会在一个影子 git 目录里拍一张快照；你自己的暂存区（index）和 stash 绝不会被动到。`/rewind` 可以恢复文件、对话，或者两者一起恢复。当代理反复以同样的方式失败时，判定器可以建议回退；它从不自己回退。

**子代理与浏览器**

- **`delegate`。** 相互独立的部分并行运行，或者按步骤串成一条链。会改文件的部分在各自的 git worktree 里工作，最后交回一个补丁。每个子代理都按自己的验收清单工作，并把清单交回来。`/implement`、`/scout-and-plan` 和 `/implement-and-review` 是现成的链。
- **`hive`（蜂群）。** 针对一个难题，几个调查者同时开工，由判定器决定哪些发现在它们之间传递。
- **内置浏览器。** `browse` 循环执行“观察 → 一次判定 → 动作”。在桌面应用里，你能在单独的浏览器面板里看到每一步，并随时接手。任何不可撤销的操作都会先问你。

**日常工具**

- **沿用你已有的配置。** mu 会读取你为 Claude Code、Cursor 和 Codex 设置好的规则、技能和 MCP 服务器。
- **能力包。** `/review` 给出按 P0–P3 分级的发现；`/commit` 把一次改动拆成几个提交，并先给你看拆分计划。另外还有 ast-grep、通过 `gh` 使用 GitHub、冲突解决，以及 DAP 调试器（debugpy、delve、lldb-dap）。
- **后台任务、网页抓取与搜索**（其中包括在中国大陆也能用的来源），以及用 Claude、ChatGPT、Grok 和 Google **登录**（通过 Gemini CLI 或 Antigravity 使用 Google 属于*实验性*功能：mu 会说明风险，并在打开浏览器之前先问你）。

**桌面应用**（`desktop/`）

- JeV 面板显示每一条判定结论。
- 浏览器面板由 mu 驱动。
- 应用里能看到人话看板和权限提示。
- 设置页由 harness 自身的 manifest 生成：判定器、判定模式、功能，以及接口兼容 OpenAI 或 Anthropic 的模型提供商。
- 带引导的首次启动和登录。
- 界面支持 13 种语言。

## 仓库结构

| 路径 | 是什么 |
| --- | --- |
| `packages/kyrn-judge` | mu 本体：判定内核、29 个判定规格以及上面所有功能，以 pi 扩展的形式提供 |
| `packages/*`（其余） | pi 的 monorepo：`ai`（提供商）、`agent`（主循环）、`coding-agent`（命令行）、`tui` 等，另打了几个小补丁 |
| `kyrn/bin` | `mu` 启动器（`mu`、`mu.cmd`、`mu.ps1`；基于 Node，无依赖） |
| `kyrn/docs` | 设计笔记、产品规划，以及每个功能各一篇文档（大多为中文） |
| `kyrn/local-judge` | 本地判定器 Laya（macOS，Core ML） |
| `desktop/` | 桌面应用（Electron，AionUi 的分叉） |

*KYRN* 是这个项目以前的名字，目录名和包名里还保留着它。

## 安装

```bash
npm i -g mu-agent
mu
```

需要 Node.js 22.19 或更新版本。包名是 `mu-agent`，命令是 `mu`，支持 macOS、Linux、Windows 和 WSL。运行 `npm i -g mu-agent@latest` 即可更新。下文的内容同样适用，只有一处不同：JeV 密钥写在环境变量或 `~/.mu/.env` 里，而不是 `kyrn/.env`。

## 从源码开始

需要 Node.js 22.19 或更新版本（推荐 24）、npm 和 git。

```bash
git clone https://github.com/qybaihe/MU.git
cd MU
npm install
kyrn/bin/mu            # Windows: kyrn\bin\mu.cmd
```

在 mu 里，`/login` 登录模型提供商，`/model` 选择模型。`/help` 列出全部命令，`/doctor` 检查配置。想把 `mu` 加进 PATH，运行 `kyrn/bin/mu link`。

**选一个判定器。** 不选的话，mu 用起来就像多了这些额外工具的 pi。

- **JeV：** 把 Vercel AI Gateway 的密钥以 `AI_GATEWAY_API_KEY` 写进 `kyrn/.env`（参见 `kyrn/.env.example`）。
- **Laya，本地运行，仅限 macOS：** 运行 `mu judge setup`。它要下载大约 930 MB，开始之前会先问你。
- **你已经在用的任何模型：** `/mu judge llm:<provider>/<model>`。

判定一开始处于 `shadow`（影子）模式，你可以先看看判定器会怎么做。信得过它之后，运行 `/mu mode default active`，或者在 `~/.mu/agent/mu.json` 里设置 `"modes": {"default": "active"}`。

**从源码运行桌面应用**，需要 [Bun](https://bun.sh)：

```bash
cd desktop
bun install
KYRN_ROOT="$(cd .. && pwd)" bun run start     # Windows (PowerShell): $env:KYRN_ROOT = (Resolve-Path ..); bun run start
```

应用运行的是 `KYRN_ROOT` 所指检出目录里的 mu，所以请先在仓库根目录运行 `npm install`。

## 构建

每次推送都由 GitHub Actions 检查。它为所有常见平台构建桌面应用，并为每个 `v*` 标签发布一个版本：

| | x64 | arm64 |
| --- | --- | --- |
| **macOS** | `.dmg`、`.zip`（Intel） | `.dmg`、`.zip`（Apple 芯片） |
| **Windows** | `.exe` 安装程序 | `.exe` 安装程序 |
| **Linux** | `.deb` | `.deb` |

每个版本还附带仓库的源码压缩包。

这些都是**预览版**：

- 它们还没有代码签名。macOS 首次启动时会要求你在*系统设置 → 隐私与安全性*里确认，Windows SmartScreen 会显示警告。
- 应用内部还没有带上 mu。它运行的是同一台机器上本仓库某个检出目录里的 mu，所以要把 `KYRN_ROOT` 设为那个检出目录。

`mu` 命令行在上述所有平台上都可以从 npm 安装（`npm i -g mu-agent`，见上文），也可以从源码运行。

## 我们正在做的

- **把 mu 放进应用里，并提供独立的二进制文件。** 下载下来的应用应当能独立运行，不需要检出仓库，也不需要 `KYRN_ROOT`；`mu` 命令在每个平台上都应当只是一个文件。
- **让应用成为使用 mu 的主要方式。** 整个流程都在桌面应用里运行，而不是通过终端桥接。这意味着要有一个原生的对话视图，由一条有序的事件流驱动。
- **一键安装本地判定器。** 在设置里安装 Laya，会显示它的大小和来源，下载任何东西之前都先征得你的同意。
- **在真机上验证 Windows 和 WSL。** 相关代码路径已经有了，也有单元测试；但还得在真实的 Windows 机器上跑一遍。
- **衡量判定器。** 针对每个判定点，统计 JeV 和 Laya 在真实会话中判对的比例，以便调整阈值。
- **语义写偏检查**（*实验性*）。模型流式输出时，判定器一路盯着，只有在输出明显违反你设定的规则时才会叫停。

详细计划及每一项的进展见 [kyrn/docs/11-out-of-the-box-roadmap.md](../../kyrn/docs/11-out-of-the-box-roadmap.md)。

## 参与贡献

请先读 [AGENTS.md](../../AGENTS.md)。简单说：用 tab 缩进，相对导入要带 `.ts` 后缀，只用可擦除的 TypeScript 语法，依赖写精确版本。运行 `npm run check` 以及你改动到的测试。完整的测试套件很慢，交给 CI 就好，每次推送它都会跑一遍。测试使用模拟判定器和假模型，从不调用真实模型。

## 致谢与许可证

- **pi** 由 Mario Zechner 及贡献者开发，采用 MIT 许可证。根目录的 [LICENSE](../../LICENSE) 适用于 `packages/` 和 `kyrn/`。
- **桌面应用基于 [AionUi](https://github.com/iOfficeAI/AionUi) 开发**，作者是 iOfficeAI，采用 Apache 2.0 许可证。应用里它叫 mu，但很多代码来自 AionUi，在此致谢。`desktop/` 保留 AionUi 的 [LICENSE](../../desktop/LICENSE)。
- 判定层中的第三方代码列在 [packages/kyrn-judge/THIRD_PARTY_NOTICES.md](../../packages/kyrn-judge/THIRD_PARTY_NOTICES.md) 里。
