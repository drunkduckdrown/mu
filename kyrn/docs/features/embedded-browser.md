# 应用内浏览器 × UltraFast 判定循环

更新日期：2026-09-22。状态：harness 一侧已完成并测试（提交 `e0a74b713`）；桌面端一侧（本文第 3 节的桥）进行中。两侧按本文的协议对接。

## 1. 要解决什么

mu 的 `browse` 工具移植自 browser-use/jev-ultrafast：主模型只说一次目标，之后每一步都是“观察页面 → 判定器一次判断（选操作 + 选目标）→ 执行 → 再观察”，中间过程不经过主模型的上下文。原来的 Skill 和 mu 在终端里的做法，都是另起一个无界面 Chrome，用户看不见过程。

桌面端里要做得更好：**同一个循环，直接驱动应用内对话旁边的浏览器面板**。比原 Skill 多出来的：

- 看得见：每一步点了什么、判定器有多大把握，实时显示在页面上方；每步判断同时进 JeV 面板。
- 管得住：随时暂停、继续、停止；暂停时可以自己操作页面（接管），继续后循环会重新观察页面再判断。
- 不可逆操作（付款、删除、发送）用应用内的确认框问正在看页面的人，而不是被桥接层直接取消。
- 登录态留在应用自己的浏览器分区里，既不碰用户的浏览器，也不用每次重新登录。
- 应用没开（纯终端）时一切照旧：mu 启动自己的 Chrome。

## 2. harness 一侧（已完成）

- `packages/kyrn-judge/src/browser/embedded.ts`：发现端点、握手、控制、确认、逐步通知。
- 发现顺序：环境变量 `MU_BROWSER_ENDPOINT`（旧名 `KYRN_BROWSER_ENDPOINT` 也认）→ 数据目录里的 `desktop-browser.json`（内容 `{ "url": "ws://127.0.0.1:<端口>/<令牌>", "pid": <应用主进程号> }`）。只接受回环地址的 `ws://`；`pid` 对应的进程不在了就当没有。
- 连上后先发 `Mu.hello`。对方不认识这个方法（普通 Chrome）或版本不符，就退回 mu 自己的浏览器。
- 子代理（`KYRN_SWARM_DEPTH`）不用应用内浏览器：几个子代理抢一个面板没有意义。
- 功能开关：`features.browser.embedded`（默认开）。
- 展示事件：`browser.run`（开始 / 结束及状态）和 `browser.step`（步号、操作类型、目标标签、URL、概率、页面是否变化）。标签来自网页，是不可信文本，只能当文字显示。

## 3. 桥的协议（桌面端要实现的）

桥是主进程里的一个回环 WebSocket 服务：随机端口，路径是随机令牌（路径不对直接拒绝），只在应用运行期间存在；启动时把地址和主进程 pid 写进 `<数据目录>/desktop-browser.json`（权限 600），退出时删掉。**不要**给整个应用开 `--remote-debugging-port`：那会把有特权的主窗口也暴露给本机任何进程。桥只对“浏览页面”的 `webContents` 调 `webContents.debugger.attach()`。

消息格式与 DevTools 协议相同：请求 `{ id, method, params, sessionId? }`，应答 `{ id, result }` 或 `{ id, error: { message } }`，事件 `{ method, params, sessionId }`。

### 3.1 需要支持的浏览器级方法

| 方法 | 桥要做的事 |
| --- | --- |
| `Target.createTarget { url }` | 在当前对话的浏览器面板里新开一个标签页（面板没打开就打开它），返回 `{ targetId }`。此时页面是 `about:blank`，随后 harness 会用 `Page.navigate` 导航 |
| `Target.attachToTarget { targetId, flatten: true }` | 对该标签页的 `webContents` 执行 `debugger.attach('1.3')`，返回 `{ sessionId }` |
| `Target.closeTarget { targetId }` | 运行结束时 harness 会调用。桥**不关闭**标签页（用户要看最终页面），只解除调试器并把该页标记为“已结束”；返回 `{ success: true }` |

### 3.2 页面级方法（带 `sessionId`）

原样转给 `webContents.debugger.sendCommand(method, params)`，结果原样返回。两个例外：

- `Emulation.setDeviceMetricsOverride`：**不转发**，直接返回 `{}`。页面应保持面板的真实尺寸。
- `Emulation.setFocusEmulationEnabled`：转发（面板没有焦点时菜单和动画仍要渲染）。

harness 实际用到的方法以 `packages/kyrn-judge/src/browser/session.ts` 为准（`Page.navigate`、`Runtime.evaluate`、`Input.*`、`DOM.*` 等），桥不需要逐个认识它们，整体透传即可。调试器的事件（`debugger.on('message')`）带上对应的 `sessionId` 发回去。

### 3.3 `Mu.` 方法（桥自己应答，不转发）

| 方法 | 应答 | 说明 |
| --- | --- | --- |
| `Mu.hello { version }` | `{ embedded: true, version: 1 }` | 握手 |
| `Mu.control {}` | `{ paused: boolean, stop: boolean }` | harness 每一步之前都会问。`paused` 期间 harness 每 400 ms 再问一次；`stop` 为真则本次运行以“已中止”结束。新一次运行开始时（下一个 `Target.createTarget`）两者复位 |
| `Mu.confirm { label, url }` | `{ allowed: boolean }` | 弹出应用内确认框：“mu 想执行：<label>”，显示页面地址。120 秒内没人回答视为拒绝。`label` 是网页文本，只能当纯文本显示 |
| `Mu.step { step, kind, action, url, probability, pageChanged }` | `{}` | 给页面上方的实时步骤条用，不需要等待 |

### 3.4 安全要求

- 只监听 `127.0.0.1`；令牌至少 128 位随机数；令牌不写日志；广告文件权限 600。
- 每个 WebSocket 连接只能操作它自己创建的标签页。
- 浏览页面用独立的 session 分区（例如 `persist:mu-browser`），与应用自身的渲染进程、与用户的系统浏览器都隔离；不给页面任何 Node 能力。
- 只允许 `http:` / `https:` 导航；下载、权限请求（摄像头、定位等）默认拒绝。
- 用户正在手动操作同一个页面时（接管），桥把 `paused` 置真，避免人与循环同时点。

## 4. 验证情况

已验证（harness）：回环地址校验；环境变量与广告文件两种发现方式、已退出应用的广告被忽略；与普通 Chrome、与更高协议版本的对端握手失败后退回；暂停时等待、停止时结束、`AbortSignal`；确认框的放行与拒绝、面板消失时一律拒绝；逐步通知不阻塞；`beforeStep` 返回假时循环在下一步之前结束且不再提问判定器。测试用一个手写的最小 WebSocket 服务充当桥（`test/browser-embedded.test.ts`，6 个用例）。

未验证：与真实桌面端桥的端到端联调（要等桥完成）；`<webview>` 内页面对 `Input.*` 事件的响应与独立 Chrome 是否完全一致；多标签、多对话并行。
