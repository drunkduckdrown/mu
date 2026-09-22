# 12. 原生桌面端计划：PI-Desktop 对照与交付路线

2026-09-23。本文是 `/goal` 交付计划的总纲：对照 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)
（Electron + Rust host core + pi harness + 插件平台，LGPL-3.0，0.15.x 早期预览）与 mu 桌面端（AionUi 分叉，
`/Users/baihe/Documents/KYRN-desktop`，分支 `codex/kyrn-desktop`），列出差距、决定取舍、分阶段派工。

许可提醒：PI-Desktop 是 LGPL-3.0，mu 桌面端是 Apache-2.0 分叉。只学它的交互与信息架构，**不复制它的代码**。

## 1. 差距对照

| 维度 | PI-Desktop | mu 桌面端（现状） | 决定 |
| --- | --- | --- | --- |
| 窗口 | macOS `hiddenInset` + 系统菜单；Win/Linux 无菜单栏的 46px 无边框行，自绘最小化/最大化/关闭 | macOS `titleBarStyle: hidden` + 交通灯；Win/Linux `frame: false` + `WindowControls` | 已接近原生，保留；去掉浏览器痕迹（下一行） |
| 登录/网页残留 | 无登录；provider 的 OAuth 只在设置里 | `/login` 用户名密码页 + `ProtectedLayout` 守门、WebUI 设置页与弹窗、微信/企微渠道、PWA 下拉刷新、浏览器通知授权、浏览器文件选择器、侧栏底部"退出 Google" | **全部移除**。provider 登录保留在设置的模型区，不做任何登录门槛 |
| 主区域 | 一窗一目的地；聊天是首页；设置是整页 | `/guid` 首页、会话页、cron、settings（15 个入口）、team（已停用）、welcome | 保留结构，收敛入口（见 §3 B） |
| 侧栏 | Sessions / Projects 两段；底部 设置 / 扩展 / 定时 / 通知 四个图标；Cmd+B 折叠 | 新会话、搜索、定时任务、助手；底部 设置 / 退出登录 / 主题 | 只留：新会话、搜索、定时；底部 设置 + 主题。助手入口并入设置 |
| 设置 | 13 个目的地分 4 组（偏好 / 智能体 / 工作区 / 系统），整页 + 左栏搜索 | mu 六段（模型、权限、判官、决策、功能、上下文）+ 模型、Agents、技能、工具、外观、WebUI、宠物、系统、归档、关于 | 收敛到 6 个：模型、权限、内核（判官+决策+功能+上下文，少量开关）、技能与工具、外观（含宠物开关）、系统（含关于、归档、日志、代理） |
| 输入框 | 悬浮胶囊；左侧模式芯片 Agent / Plan / Goal；权限芯片；模型与思考强度选择 | 发送框内已有权限模式；`/goal` 走斜杠命令；无模型/思考选择 | 补：模式芯片（普通 / 目标）、模型 + 思考强度选择器；思考强度默认**不随回合切换**（见 §4） |
| 工具调用呈现 | ToolRow 折叠一行，连续调用合成 ActivityGroup，子代理有 SubagentDetail，思考过程可选显示 | MessageToolCall / MessageAcpToolCall / MessageThinking 各自成块 | 补：折叠行 + 活动分组 + 子代理详情；思考流成一条安静的线 |
| 工作面板 | 右侧停靠：文件 / 浏览器 / 评审，Cmd+J | Preview + explorer + SourceControl + KyrnPanel（看板、判官、蜂群） | 已有对应物，统一成一个右侧面板的标签页（P2） |
| 全局搜索 / 命令面板 | Cmd+K / Cmd+Shift+P，搜索会话、设置、命令 | 会话搜索弹层 | 补：Cmd+K 命令面板 = 会话 + 设置 + 斜杠命令 |
| 通知 | 底部铃铛的本地收件箱 + toast | 桌面通知（回合结束） | P2 视情况补收件箱 |
| 定时任务 | Scheduled 编辑器（模型选择、星期） | cron 页 | 已有，保留 |
| 项目归档 / PR 页 / 导入 / 云同步 / 远程主机 | 有 | 无 | 不做（超出"开箱即用的本地 harness"） |
| 插件平台 | `.piplug` 市场、面板、悬浮窗、主题 | 无；有能力包（catalog）与技能 | 不做插件平台；能力包走自己的路 |
| 网络代理 | System / Direct / Custom，含旁路列表 | 无 | P2 在"系统"里补一个代理设置（用户网络 TLS 冷连接 1.4 s，值得） |
| 命名 | PI-Desktop 全链一致 | electron-builder 已是 mu（appId、协议、产物）；`packages/desktop` 包名仍是 `@aionui/desktop` 0.0.0；界面残留 AionUi 文案 | 统一为 mu：包名、窗口标题、About、Dock 名、文案 |

## 2. 设计红线（来自用户）

- 白底或黑底；淡粉、淡紫只用在按钮这类小点缀上，不给面板染色。
- μ 一律 U+03BC，可在少数位置作为元素出现，不多、不复杂。
- 极简：菜单少、开关少；每个设置区的"重心都降一降"。
- 没有登录门槛；不复用浏览器的感觉。
- 每次调用看起来都要流畅；工具盒要好用。
- 思考强度：切换会丢缓存，同一模型尽量不切；子代理的思考强度一旦定下不再变。

## 3. 阶段与派工

子代理：Opus，同时最多 2–3 个，各自在桌面仓库的独立 worktree（`git worktree add .claude/worktrees/<名> -b claude/<名> codex/kyrn-desktop`）里工作并提交 WIP；组织者负责合并（ff-only 到 `codex/kyrn-desktop`）、内核与文档。

### P1（进行中）

- **A 原生外壳**（子代理）：移除登录页与守门、WebUI 页面与弹窗、渠道表单、PWA / 浏览器通知 / 浏览器文件选择器残留、侧栏"退出登录"；命名统一为 mu；`bunx tsc --noEmit` + 相关 vitest 通过。
- **C 调用流畅**（子代理）：工具调用折叠行 + 活动分组 + 子代理详情；思考流；流式渲染不抖动（行级 memo、rAF 合并、粘底滚动）；`goal_check` 进度码 13 语言翻译。
- **内核**（组织者）：预检不再按档位切思考强度（默认关，只提示）；子代理路由时同模型沿用会话的思考强度；delegate / hive 的输出免于准入裁剪。

### P2

- **B 侧栏与设置收敛 + μ 极简视觉**：侧栏三项 + 底部两项；设置六段；宠物成开关；淡粉淡紫只在按钮。
- **D 命令面板**：Cmd+K = 会话搜索 + 设置跳转 + 斜杠命令；铃铛收件箱视情况。
- **E 输入框**：模式芯片（普通 / 目标）、模型 + 思考强度选择器，遵守不切换规则；右侧面板统一为标签页。

### P3 生产交付

- 首次启动：引导 → 模型 → 一键 Laya（下载需同意）。
- 命名与标识：图标、About、Dock、`mu://`、产物名；README 与发布说明交公开仓库会话。
- 打包核对：macOS / Windows（含 WSL 分支 `claude/mu-windows` 已并入）/ Linux。

## 4. 内核：思考强度与缓存

多数 provider 在思考强度改变时丢掉提示缓存（Anthropic 的 thinking 参数变化会让消息缓存失效）。现状：预检按档位
把 chat / light 回合压到 low、heavy 抬到 high，每次切换都是一次缓存冷启动。改法：

- `preflight.thinking` 默认 `false`：档位只给提示，不动思考强度；用户可在 kyrn.json 打开。
- 子代理路由：判官选的模型等于会话模型时，思考强度沿用会话的；只有换模型时才由判官选。
- 每只蜜蜂的思考强度在 spawn 时定死（已是如此），运行中不变。
