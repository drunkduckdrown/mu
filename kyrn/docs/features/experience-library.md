# 经验库（`memory`）第二版：Jev 深度融合

更新日期：2026-09-23。状态：设计已定，实现进行中（harness 分支 `claude/mu-experience-library`）。第一版（只记用户纠正、按触发条件召回）见 `04-injection-points.md` A5 / D2。

## 1. 要解决什么

第一版的经验库是一个只增不减的 `lessons.jsonl`：用户纠正一次，Jev 判断"这是不是纠正或长期规则"，写作模型把它写成"触发条件 + 该怎么做"一行；下次消息到来时，Jev 逐条问"这条适不适用"，适用的以一行注入。它有三个缺口：

- **只从用户嘴里学**。代理自己踩坑再爬出来（同一个命令失败三次、换个办法就过了）、子代理报告里的发现、目标模式最终怎么达成的，都没记下来。
- **不整理**。同一件事说两遍就存两条；用户改口了，旧的还在，而且两条都可能被召回、互相打架。
- **不知道有没有用**。一条经验被召回了几十次，模型从没照做，也一直占着召回名额。

用户的话（2026-09-23）："经验库也是一个核心打造的事情，要有一个 Jev 的深度与融合。"

## 2. 原则

- **Jev 只做判断，从不生成**：值不值得记、和已有的是不是同一条、这次适不适用、模型照做了没有。写成一行字的活交给 writer 模型；没有 writer 就留用户原话。
- **一行进上下文**：召回的经验仍然一条一行，最多 `maxInjected` 条；经验库再大也不涨提示词。
- **用户的最新说法赢**：新经验与旧经验矛盾时，旧的退役，不问用户。
- **只增不改的文件**：每次变化追加一行（同一 `id` 以最后一行为准），和决策台账一个做法；损坏一行不伤其余。

## 3. 存什么

`<agentDir>/mu/lessons.jsonl`，每行一条：

| 字段 | 说明 |
| --- | --- |
| `id` | 不变 |
| `kind` | `correction`（纠正）/ `preference`（长期规则）/ `pitfall`（踩过的坑）/ `workaround`（绕过办法）/ `fact`（项目事实） |
| `trigger` | 什么情况下适用，一句话；召回时 Jev 拿它去对新消息 |
| `lesson` | 该怎么做，一句祈使句；注入的就是它 |
| `scope` | `{ cwd }` 只在这个项目；`{}` 到处适用 |
| `source` | `{ origin: "user" \| "outcome" \| "model" \| "subagent" \| "command", session?, turn? }` |
| `status` | `active` / `retired` / `superseded` |
| `supersedes` | 被这条替代的旧 `id` |
| `uses` | `{ recalled, applied, lastRecalled }` |
| `created`, `updated` | ISO 时间 |

读取时按 `id` 折叠，`status !== "active"` 的不进候选。第一版的旧行（没有 `kind`/`status`）按 `correction` / `active` 读，不用迁移。

## 4. 从哪里学（写入侧）

| 来源 | 触发 | Jev 判断 | 谁写成一行 |
| --- | --- | --- | --- |
| 用户纠正 / 规则 | 用户消息到达（第一版已有） | `memory.capture`：纠正？规则？ | writer |
| **代理自己的坑** | 监视器报过原地打转或死路（`runtime.onTrouble`），随后这一轮以通过的检查或达成的目标结束 | `memory.outcome`：`way_out` 布尔：从这一轮的摘要看，最后奏效的办法和一开始的办法不同吗？ | writer：坑（trigger）+ 绕过办法（lesson），`kind: workaround` |
| **模型主动记** | 新工具 `remember({ trigger, lesson })` | `memory.worth`（选择题）：这是 `reusable`（以后还会用上）/ `one_off`（只关这一次）/ `already_known`（提示词或项目文件里就有）；只有 `reusable` 才存 | 模型自己写的，writer 不再改 |
| **子代理的发现** | 子代理报告里以 `Lesson:` 开头的行（角色提示里教它这样写） | 同 `memory.worth` | 原句 |
| `/remember <文字>` | 用户命令（第一版已有） | 不判断，直接存 | 原句 |

`memory.outcome` 一轮最多问一次，且只在这一轮真的出过麻烦时问：不给正常的一轮增加任何调用。

## 5. 整理（写入前）

新经验落盘前，先取同作用域里最像的 K 条（`K = 6`，按 trigger/lesson 的词面重合排序，不调判官），一次请求问 Jev `memory.merge`，每条一个选择题：

> 和 `candidate` 相比，`existing_N` 是 `same`（同一条经验）/ `refines`（新的说得更准或更具体）/ `contradicts`（两者不能同时成立）/ `unrelated`。

- `same`：不存新的，旧的 `uses.recalled` 不动、`updated` 更新。
- `refines`：存新的，旧的记 `superseded`，新的 `supersedes` 指向它。
- `contradicts`：存新的，旧的 `retired`（用户的最新说法赢；模型主动记的不能让用户纠正的退役——只有 `source.origin` 为 `user` 或 `command` 的新经验才能让旧经验退役）。
- `unrelated`：正常存。

## 6. 召回（读取侧）

第一版的做法不变：消息一到就和预检并行问 `memory.recall`（每条一个布尔题），确信适用的注入，最多 `maxInjected` 条。第二版加三件事：

- **候选排序**：同作用域的活跃经验按 `uses.applied` 降序、`updated` 降序取前 `maxCandidates` 条，而不是文件末尾的 24 条。
- **记账**：每条被注入的经验 `uses.recalled + 1`、`lastRecalled`。
- **有没有用**：一轮结束（`agent_end`）时，对这一轮注入过的经验批量问一次 `memory.applied`（每条一个布尔题："从 `turn_digest` 看，助手照 `lesson_N` 做了吗？"），确信是的记 `uses.applied + 1`。召回 ≥ `retireAfter`（默认 8）次而从未 `applied` 的经验自动 `retired`，并展示一条 `memory.retired`。这是规则，不再问判官。

## 7. 子代理

`delegate` / `hive` 给每个任务做简报时，用任务文字再跑一次 `memory.recall`（候选是父会话同作用域的经验），命中的写进简报的"已知经验"一段。蜜蜂不写经验库，只在报告里写 `Lesson:` 行，由父会话按第 4 节处理。

## 8. 界面

命令：

| 命令 | 作用 |
| --- | --- |
| `/remember <文字>` | 存一条（已有） |
| `/lessons` | 列出这个项目能用上的经验：`id 前 8 位 · kind · 召回/照做次数 · lesson` |
| `/lessons all` | 含到处适用的和已退役的 |
| `/forget <id 前缀>` | 退役一条 |

展示事件（桌面端画面板用）：`memory.stored`（已有，载荷是整条记录）、`memory.recalled`（`{ ids, turn }`）、`memory.applied`（`{ ids }`）、`memory.retired`（`{ id, reason }`）、`memory.merged`（`{ id, into, how }`）。桌面端的经验面板直接读 `lessons.jsonl`（按 `id` 折叠），编辑和删除通过追加行完成：改 `lesson` 就追加一行同 `id` 的记录，删除就追加 `status: "retired"`。

## 9. 没做、待定

- `memory.applied` 用的是轮摘要（`recentTurnDigests`），长轮里被截断的部分看不见；先接受。
- 经验按语言 / 工具分作用域（比如"pytest 相关"）：等有真实数据再说。
- 蒸馏成 Laya 可用的分类：召回题是布尔题，本地判官偏软（见 `03-local-judge.md`），先只在 Jev 上开。

## 10. 验证

- 单元测试（mock 判官）：写入折叠、五种来源各一条、`merge` 四种结果、召回排序与记账、`applied` 与退役、`/lessons` / `/forget`、子代理简报里的经验段。
- 真实 Jev：一次脚本跑通"纠正 → 存 → 改口 → 旧的退役 → 召回只给新的"，记录延迟与 token。
