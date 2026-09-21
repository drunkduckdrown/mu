/**
 * What the harness offers, described for people: every decision point and every
 * feature with its options, in Chinese and English. A settings screen renders
 * its controls from this, so nothing the harness can do is hidden from the user.
 *
 * `manifest.json` next to the package's `package.json` is this object as data,
 * for clients that do not import TypeScript (the desktop app reads it). Tests
 * keep both in step with the code: a decision or a feature that is missing
 * here fails `test/manifest.test.ts`.
 *
 * Regenerate the JSON after a change: `node packages/kyrn-judge/scripts/write-manifest.ts`.
 */
export interface Localized {
	readonly zh: string;
	readonly en: string;
}

export type DecisionGroup = "input" | "context" | "tools" | "turn" | "team";

export interface DecisionInfo {
	/** The spec id, which is also the key under `modes` in mu.json. */
	readonly id: string;
	readonly group: DecisionGroup;
	/** The feature that asks it: switching that feature off silences the decision. */
	readonly feature: string;
	readonly title: Localized;
	readonly summary: Localized;
}

interface OptionBase {
	/** The key under `features.<name>` in mu.json. */
	readonly key: string;
	readonly label: Localized;
	readonly help?: Localized;
}

export type OptionInfo =
	| (OptionBase & { readonly kind: "boolean"; readonly default: boolean })
	| (OptionBase & {
			readonly kind: "number";
			readonly default: number;
			readonly min?: number;
			readonly max?: number;
			readonly unit?: Localized;
	  })
	| (OptionBase & { readonly kind: "text"; readonly default: string })
	| (OptionBase & { readonly kind: "list"; readonly default: readonly string[] })
	| (OptionBase & { readonly kind: "numbers"; readonly default: readonly number[] })
	| (OptionBase & {
			readonly kind: "choice";
			readonly default: string;
			readonly choices: readonly { readonly value: string; readonly label: Localized }[];
	  });

export interface FeatureInfo {
	/** The key under `features` in mu.json. `false` there switches the feature off. */
	readonly name: string;
	readonly title: Localized;
	readonly summary: Localized;
	readonly defaultEnabled: boolean;
	readonly beta?: boolean;
	readonly options: readonly OptionInfo[];
}

export interface HarnessManifest {
	readonly version: 1;
	readonly groups: Readonly<Record<DecisionGroup, Localized>>;
	readonly modes: readonly {
		readonly value: "off" | "shadow" | "active";
		readonly label: Localized;
		readonly help: Localized;
	}[];
	readonly decisions: readonly DecisionInfo[];
	readonly features: readonly FeatureInfo[];
}

const ms: Localized = { zh: "毫秒", en: "ms" };
const chars: Localized = { zh: "字符", en: "chars" };

export const MANIFEST: HarnessManifest = {
	version: 1,
	groups: {
		input: { zh: "输入", en: "Input" },
		context: { zh: "上下文", en: "Context" },
		tools: { zh: "工具与安全", en: "Tools and safety" },
		turn: { zh: "回合", en: "Turn" },
		team: { zh: "协作", en: "Teamwork" },
	},
	modes: [
		{
			value: "active",
			label: { zh: "生效", en: "Active" },
			help: { zh: "判定结果直接起作用。", en: "The verdict takes effect." },
		},
		{
			value: "shadow",
			label: { zh: "影子", en: "Shadow" },
			help: {
				zh: "照常提问并记录，但不改变任何行为，用来先观察判定准不准。",
				en: "Asked and recorded, but nothing changes. For watching how well it judges first.",
			},
		},
		{
			value: "off",
			label: { zh: "关闭", en: "Off" },
			help: { zh: "不提问，行为与原版 pi 相同。", en: "Not asked. Behaves like plain pi." },
		},
	],
	decisions: [
		{
			id: "input.preflight",
			group: "input",
			feature: "preflight",
			title: { zh: "消息预判", en: "Message preflight" },
			summary: {
				zh: "每条消息先判断是什么类型、要多深的思考，据此设定本回合的思考等级并给出一行提示。",
				en: "Classifies each message and how much thinking it needs, then sets the turn's thinking level and a one-line hint.",
			},
		},
		{
			id: "task.frame",
			group: "input",
			feature: "frame",
			title: { zh: "任务帧更新", en: "Task frame update" },
			summary: {
				zh: "每条消息判断一次：它是新任务、新的硬约束、对做法的纠正、新的子目标，还是什么都没变。只有变了才让模型重写任务帧。",
				en: "Asks of each message: a new task, a new hard constraint, a correction, a new subgoal, or no change. Only a change has a model rewrite the task frame.",
			},
		},
		{
			id: "input.interjection",
			group: "input",
			feature: "interjection",
			title: { zh: "中途插话", en: "Mid-run messages" },
			summary: {
				zh: "任务进行中你又发来一句话：判断是要立刻打断，还是等这一步做完再处理。",
				en: "A message that arrives while the agent works: interrupt now, or handle it after the current step.",
			},
		},
		{
			id: "skills.disclosure",
			group: "context",
			feature: "skills",
			title: { zh: "技能披露", en: "Skill disclosure" },
			summary: {
				zh: "会话开始时只把与任务有关的技能说明放进提示词，其余隐藏但随时可查。",
				en: "Only skills relevant to the task go into the prompt; the rest stay hidden but findable.",
			},
		},
		{
			id: "capability.disclosure",
			group: "context",
			feature: "catalog",
			title: { zh: "能力披露", en: "Capability disclosure" },
			summary: {
				zh: "能力包、MCP 服务器等装着但默认不露，任务需要时才打开，对应的进程也到那时才启动。",
				en: "Packs and MCP servers are installed but hidden, opened only when a task needs them; their processes start then.",
			},
		},
		{
			id: "tool.admission",
			group: "context",
			feature: "admission",
			title: { zh: "工具输出准入", en: "Tool output admission" },
			summary: {
				zh: "很长的工具输出分块判断，只让与任务有关的部分进入上下文，其余归档并留下指针。",
				en: "Long tool output is judged in chunks; only what matters enters the context, the rest is archived with a pointer.",
			},
		},
		{
			id: "tool.admission.test-log",
			group: "context",
			feature: "admission",
			title: { zh: "测试日志精简", en: "Test log trimming" },
			summary: {
				zh: "测试输出里完全重复的失败段落只留一份；可再让判定器挑出必要的部分。",
				en: "Exact repeats in test output are kept once; optionally the judge selects what is needed from the rest.",
			},
		},
		{
			id: "context.forget",
			group: "context",
			feature: "forgetting",
			title: { zh: "过期结果遗忘", en: "Forgetting stale results" },
			summary: {
				zh: "上下文用量越过阈值时，把已经用不上的旧工具结果在发出的请求里换成一行占位。",
				en: "When context use crosses a threshold, stale tool results are replaced by one-line tombstones in outgoing requests.",
			},
		},
		{
			id: "context.compact",
			group: "context",
			feature: "compaction",
			title: { zh: "免摘要压缩", en: "Summary-free compaction" },
			summary: {
				zh: "压缩时不让模型写摘要，而是逐段判断保留还是裁掉，原文保真。",
				en: "Compaction keeps or prunes passages by judgment instead of asking a model for a summary.",
			},
		},
		{
			id: "memory.recall",
			group: "context",
			feature: "memory",
			title: { zh: "经验召回", en: "Lesson recall" },
			summary: {
				zh: "从经验库里挑出与当前任务有关的几条，带进这一回合。",
				en: "Picks the lessons relevant to the current task and brings them into the turn.",
			},
		},
		{
			id: "memory.capture",
			group: "context",
			feature: "memory",
			title: { zh: "经验记录", en: "Lesson capture" },
			summary: {
				zh: "判断一段经历值不值得记成经验。",
				en: "Decides whether something that happened is worth keeping as a lesson.",
			},
		},
		{
			id: "cache.warming",
			group: "context",
			feature: "warming",
			title: { zh: "缓存保温", en: "Cache warming" },
			summary: {
				zh: "判断你是否很快会回来，以决定要不要在提示词缓存过期前续一下。",
				en: "Guesses whether you will be back soon, to decide on refreshing the prompt cache before it expires.",
			},
		},
		{
			id: "tool.risk",
			group: "tools",
			feature: "guard",
			title: { zh: "危险命令把关", en: "Risky command guard" },
			summary: {
				zh: "规则先挑出看起来危险的命令，判定器只负责确认“这是不是你要求的”；拿不准就问你。",
				en: "Rules flag dangerous-looking commands; the judge only vouches that you asked for it. Unsure means asking you.",
			},
		},
		{
			id: "tool.constraint",
			group: "tools",
			feature: "constraints",
			title: { zh: "硬约束把关", en: "Hard constraint gate" },
			summary: {
				zh: "你说过“先别改 X”“不要加依赖”这类话会原文记在任务帧里；每次要改动东西之前，逐条判断这次调用是否违反，确信违反才拦下，并用你的原话告诉模型。",
				en: "What you ruled out is kept word for word in the task frame; before a call that changes something, each constraint is checked, and only a confident violation is stopped, in your own words.",
			},
		},
		{
			id: "files.locate",
			group: "tools",
			feature: "locate",
			title: { zh: "文件定位", en: "File location" },
			summary: {
				zh: "用一句话描述要找什么，判定器给候选文件排序，省去一连串 grep。",
				en: "Describe what you are looking for; the judge ranks candidate files instead of a string of greps.",
			},
		},
		{
			id: "browser.step",
			group: "tools",
			feature: "browser",
			title: { zh: "浏览器逐步操作", en: "Browser steps" },
			summary: {
				zh: "内置浏览器每一步“观察 → 一次判定 → 动作”，由判定器选择下一步操作和目标。",
				en: "Each browser step is observe, one judgment, act: the judge picks the next operation and its target.",
			},
		},
		{
			id: "turn.drift",
			group: "turn",
			feature: "monitor",
			title: { zh: "跑偏监测", en: "Drift monitor" },
			summary: {
				zh: "每隔几步判断当前工作是否还在为目标服务，并用规则发现原地打转。",
				en: "Every few steps, checks that the work still serves the goal; rules catch going in circles.",
			},
		},
		{
			id: "turn.rewind",
			group: "turn",
			feature: "checkpoint",
			title: { zh: "判断回退", en: "Judged rewind" },
			summary: {
				zh: "监测发现原地打转或同一条命令连续失败时，判断这条路是不是死路；只有确信是死路且没有进展，才向你提议回到本回合开始前的检查点。它自己从不回退。",
				en: "When the monitor sees the agent going in circles, or one command failing again and again, judges whether the approach is a dead end; only a confident dead end with no progress proposes going back to the turn's checkpoint. It never rewinds by itself.",
			},
		},
		{
			id: "turn.completion",
			group: "turn",
			feature: "completion",
			title: { zh: "完成核对", en: "Completion check" },
			summary: {
				zh: "模型说“做完了”时，判断是否真的验证过；没验证就提醒一次。",
				en: "When the model says it is done, checks whether anything verified that; one nudge if not.",
			},
		},
		{
			id: "output.drift",
			group: "turn",
			feature: "ttsr",
			title: { zh: "写偏即停（实验）", en: "Mid-stream correction (experiment)" },
			summary: {
				zh: "模型边输出，判定器边每隔几百字对照一次你的硬约束和下面配置的规则；确信写偏了就立刻掐断输出，告诉模型是哪一条，让它从断点接着写。只有开启了“写偏即停”功能才会运行。",
				en: "While the model writes, the judge reads the tail of its output against your hard constraints and the configured rules every few hundred characters; on a confident violation the output is cut, the rule is named, and the model carries on from there. Runs only with the feature switched on.",
			},
		},
		{
			id: "goal.met",
			group: "turn",
			feature: "goal",
			title: { zh: "目标是否达成", en: "Goal reached" },
			summary: {
				zh: "用 /goal 定下目标后，模型每次想停下来，都判断一次目标是否已经达成：没达成就让它继续干，需要你拿主意就停下来等你。还有没勾掉的验收条件、或改完没跑过，一律算没达成。",
				en: "With a goal set by /goal, each time the model wants to stop the judge reads whether the goal holds: if not, the agent is sent back to work; if it needs you, it waits. An open acceptance item or an unverified edit always means not yet.",
			},
		},
		{
			id: "notify.routing",
			group: "turn",
			feature: "notify",
			title: { zh: "通知分流", en: "Notification routing" },
			summary: {
				zh: "上下文预算等事件出现时，判断该现在告诉模型、稍后再说，还是不必说。",
				en: "For events such as the context budget: tell the model now, later, or not at all.",
			},
		},
		{
			id: "swarm.routing",
			group: "team",
			feature: "swarm",
			title: { zh: "子代理分派", en: "Sub-agent routing" },
			summary: {
				zh: "为每个委派任务挑选角色，并按难度选择模型档位和思考等级。",
				en: "Picks a role for each delegated task, and a model tier and thinking level by difficulty.",
			},
		},
		{
			id: "hive.publish",
			group: "team",
			feature: "hive",
			title: { zh: "蜂群：发布发现", en: "Hive: publishing findings" },
			summary: {
				zh: "一只蜂的发现值不值得放到公告板上给其他蜂看。",
				en: "Whether a bee's finding is worth putting on the board for the others.",
			},
		},
		{
			id: "hive.deliver",
			group: "team",
			feature: "hive",
			title: { zh: "蜂群：投递", en: "Hive: delivery" },
			summary: {
				zh: "公告板上的一条发现与某只蜂手头的工作有没有关系，有关系才送达。",
				en: "Whether a finding on the board matters to a bee's current work; only then is it delivered.",
			},
		},
	],
	features: [
		{
			name: "preflight",
			title: { zh: "消息预判", en: "Message preflight" },
			summary: {
				zh: "发送后先判定再开工，判定结果显示在对话里。",
				en: "Judges a message before work starts and shows the verdict in the conversation.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "thinking",
					kind: "boolean",
					default: true,
					label: { zh: "按判定设置思考等级", en: "Set the thinking level from the verdict" },
				},
				{
					key: "hints",
					kind: "boolean",
					default: true,
					label: { zh: "给模型一行提示", en: "Give the model a one-line hint" },
				},
				{
					key: "show",
					kind: "boolean",
					default: true,
					label: { zh: "在界面上显示等待和结论", en: "Show the wait and the verdict" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 6000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
					help: { zh: "超时就不等了，按原样开始。", en: "After this the turn starts without the verdict." },
				},
			],
		},
		{
			name: "interjection",
			title: { zh: "中途插话", en: "Mid-run messages" },
			summary: { zh: "处理任务进行中发来的消息。", en: "Handles messages sent while the agent is working." },
			defaultEnabled: true,
			options: [
				{
					key: "waitMs",
					kind: "number",
					default: 1500,
					min: 200,
					max: 10000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
				},
			],
		},
		{
			name: "skills",
			title: { zh: "技能披露", en: "Skill disclosure" },
			summary: {
				zh: "按任务决定提示词里带哪些技能说明。",
				en: "Chooses which skill descriptions a session carries.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "minSkills",
					kind: "number",
					default: 4,
					min: 1,
					max: 100,
					label: { zh: "技能少于这个数就不筛", en: "Do not filter below this many skills" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
				},
			],
		},
		{
			name: "catalog",
			title: { zh: "能力目录", en: "Capability catalog" },
			summary: {
				zh: "装得多、露得少：能力包和 MCP 服务器默认隐藏，按任务打开。",
				en: "Install a lot, expose little: packs and MCP servers stay hidden and open per task.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "waitMs",
					kind: "number",
					default: 4000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
				},
			],
		},
		{
			name: "frame",
			title: { zh: "任务帧与待办", en: "Task frame and to-do list" },
			summary: {
				zh: "记住你到底要什么：目标、你的硬约束（原话加出处）、当前子目标、验收条件。验收条件就是待办清单，模型用 todo 工具勾选。所有“和目标相关吗”的判断都以它为准，回退会话时它跟着回退。",
				en: "Keeps what you actually want: the goal, your hard constraints (your own words, with their source), the current subgoal and the acceptance items. Those items are the to-do list the model ticks with the todo tool. Every goal-relevance judgment reads it, and it rewinds with the session.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "waitMs",
					kind: "number",
					default: 3000,
					min: 0,
					max: 30000,
					unit: ms,
					label: { zh: "回合最多等任务帧多久", en: "A turn waits for its frame at most" },
					help: {
						zh: "从消息到达算起。超时不丢弃：本回合先用上一版加这条原话，更新完成后照常落地。",
						en: "Counted from the arrival of the message. A late update is not dropped: the turn starts on the previous version plus the raw message, and the update lands when it is ready.",
					},
				},
				{
					key: "writerTimeoutMs",
					kind: "number",
					default: 20000,
					min: 1000,
					max: 120000,
					unit: ms,
					label: { zh: "重写任务帧的时限", en: "Time limit for writing a frame" },
					help: {
						zh: "超时或写坏了就保留上一版并标记为过期，按目标筛选上下文的功能暂停，下一条消息时重试。",
						en: "On a timeout or a malformed reply the last version stays and is marked stale, goal-based filtering holds back, and the next message retries.",
					},
				},
				{
					key: "show",
					kind: "boolean",
					default: true,
					label: { zh: "在对话里显示任务帧更新", en: "Show frame updates in the chat" },
				},
			],
		},
		{
			name: "memory",
			title: { zh: "经验库", en: "Lessons" },
			summary: {
				zh: "记下踩过的坑，下次遇到相关任务时带上。",
				en: "Keeps lessons learned and brings the relevant ones along next time.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "path",
					kind: "text",
					default: "",
					label: { zh: "经验库文件", en: "Lessons file" },
					help: { zh: "留空使用默认位置。", en: "Empty uses the default location." },
				},
				{
					key: "maxCandidates",
					kind: "number",
					default: 24,
					min: 1,
					max: 200,
					label: { zh: "每次最多评估", en: "Judge at most" },
				},
				{
					key: "maxInjected",
					kind: "number",
					default: 5,
					min: 0,
					max: 20,
					label: { zh: "每回合最多带入", en: "Bring in at most" },
				},
			],
		},
		{
			name: "guard",
			title: { zh: "危险命令把关", en: "Risky command guard" },
			summary: { zh: "危险命令在执行前确认。", en: "Confirms dangerous commands before they run." },
			defaultEnabled: true,
			options: [],
		},
		{
			name: "constraints",
			title: { zh: "硬约束把关", en: "Hard constraint gate" },
			summary: {
				zh: "改动文件或执行命令之前，对照你的硬约束检查一遍；子代理同样受这些约束限制。",
				en: "Checks a change or a command against your hard constraints first; sub-agents work under them too.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "maxConstraints",
					kind: "number",
					default: 6,
					min: 1,
					max: 20,
					label: { zh: "每次最多对照的约束条数", en: "Constraints checked per call at most" },
					help: { zh: "取最新的几条。", en: "The newest ones are used." },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 5000,
					min: 500,
					max: 30000,
					unit: ms,
					label: { zh: "最多等待", en: "Wait at most" },
				},
			],
		},
		{
			name: "admission",
			title: { zh: "工具输出准入", en: "Tool output admission" },
			summary: {
				zh: "控制多长的工具输出、以什么方式进入上下文。",
				en: "Controls how long tool output enters the context.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "minChars",
					kind: "number",
					default: 4000,
					min: 500,
					max: 200000,
					unit: chars,
					label: { zh: "超过这个长度才筛", en: "Only filter output longer than" },
				},
				{
					key: "chunkChars",
					kind: "number",
					default: 1200,
					min: 200,
					max: 20000,
					unit: chars,
					label: { zh: "每块大小", en: "Chunk size" },
				},
				{
					key: "maxChunks",
					kind: "number",
					default: 48,
					min: 4,
					max: 400,
					label: { zh: "最多判断的块数", en: "Judge at most this many chunks" },
				},
				{
					key: "passThrough",
					kind: "list",
					default: ["read", "edit", "write"],
					label: { zh: "这些工具的输出不筛", en: "Never filter these tools" },
				},
				{
					key: "testLog",
					kind: "choice",
					default: "off",
					label: { zh: "测试日志精简", en: "Test log trimming" },
					choices: [
						{ value: "off", label: { zh: "关闭", en: "Off" } },
						{
							value: "rules",
							label: { zh: "只去掉完全重复的段落（无损）", en: "Drop exact repeats only (lossless)" },
						},
						{
							value: "jev",
							label: { zh: "再由判定器挑选剩余部分", en: "Also let the judge select from the rest" },
						},
					],
				},
				{
					key: "agentEnv",
					kind: "boolean",
					default: true,
					label: { zh: "告诉测试工具“读者是代理”", en: "Tell test runners an agent is reading" },
					help: {
						zh: "Vitest 等会因此只输出失败和汇总。",
						en: "Vitest and others then print failures and the summary only.",
					},
				},
			],
		},
		{
			name: "forgetting",
			title: { zh: "过期结果遗忘", en: "Forgetting stale results" },
			summary: {
				zh: "上下文吃紧时，把用不上的旧结果换成占位。",
				en: "Replaces stale results with tombstones when the context gets tight.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "thresholds",
					kind: "numbers",
					default: [50, 70, 85],
					label: { zh: "触发阈值（上下文用量 %）", en: "Trigger thresholds (context use %)" },
				},
				{
					key: "minChars",
					kind: "number",
					default: 6000,
					min: 500,
					max: 200000,
					unit: chars,
					label: { zh: "只考虑长于此的结果", en: "Only results longer than" },
				},
				{
					key: "minAgeTurns",
					kind: "number",
					default: 2,
					min: 0,
					max: 50,
					label: { zh: "至少过了几个回合", en: "At least this many turns old" },
				},
				{
					key: "maxPerBatch",
					kind: "number",
					default: 12,
					min: 1,
					max: 100,
					label: { zh: "每批最多判断", en: "Judge at most per batch" },
				},
			],
		},
		{
			name: "compaction",
			title: { zh: "免摘要压缩", en: "Summary-free compaction" },
			summary: {
				zh: "压缩时保留原文片段，不写摘要。",
				en: "Compaction that keeps original passages instead of a summary.",
			},
			defaultEnabled: false,
			beta: true,
			options: [
				{
					key: "keepThreshold",
					kind: "number",
					default: 0.5,
					min: 0,
					max: 1,
					label: { zh: "保留阈值", en: "Keep threshold" },
				},
				{
					key: "minChars",
					kind: "number",
					default: 600,
					min: 100,
					max: 20000,
					unit: chars,
					label: { zh: "短于此的原样保留", en: "Keep anything shorter than" },
				},
				{
					key: "headChars",
					kind: "number",
					default: 300,
					min: 0,
					max: 5000,
					unit: chars,
					label: { zh: "裁掉时保留的开头", en: "Head kept when pruning" },
				},
				{
					key: "targetRatio",
					kind: "number",
					default: 0.5,
					min: 0.05,
					max: 1,
					label: { zh: "压缩后占原来的比例", en: "Target share of the original" },
				},
				{
					key: "maxWindowShare",
					kind: "number",
					default: 0.25,
					min: 0.05,
					max: 0.9,
					label: { zh: "最多占上下文窗口的比例", en: "At most this share of the window" },
				},
				{
					key: "freeChars",
					kind: "number",
					default: 24000,
					min: 0,
					max: 500000,
					unit: chars,
					label: { zh: "小于此的历史不受预算挤压", en: "Histories this small are not squeezed" },
				},
				{
					key: "maxJudged",
					kind: "number",
					default: 120,
					min: 10,
					max: 1000,
					label: { zh: "最多判断的片段数", en: "Judge at most this many passages" },
				},
			],
		},
		{
			name: "checkpoint",
			title: { zh: "检查点与回退", en: "Checkpoints and rewind" },
			summary: {
				zh: "每个会改文件的回合，在第一次改动前给工作区拍一张快照，存在 mu 自己的影子 git 目录里，不碰你的仓库。/rewind 让文件和对话一起回到那一刻，/rewind undo 撤销回退。",
				en: "Before the first change of every turn that edits files, snapshots the working tree into mu's own shadow git directory, never touching your repository. /rewind takes files and conversation back, /rewind undo takes the rewind back.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "dir",
					kind: "text",
					default: "",
					label: { zh: "快照存放目录", en: "Where snapshots are kept" },
					help: {
						zh: "留空则放在 mu 主目录的 mu/checkpoints 下，每个项目一个影子仓库。",
						en: "Empty means mu/checkpoints in the mu home, one shadow repository per project.",
					},
				},
				{
					key: "keep",
					kind: "number",
					default: 50,
					min: 1,
					max: 1000,
					label: { zh: "每个项目保留的快照数", en: "Snapshots kept per project" },
				},
				{
					key: "maxAgeDays",
					kind: "number",
					default: 14,
					min: 1,
					max: 365,
					label: { zh: "快照保留天数", en: "Days a snapshot is kept" },
					unit: { zh: "天", en: "days" },
				},
				{
					key: "maxFileMb",
					kind: "number",
					default: 5,
					min: 1,
					max: 1024,
					label: { zh: "单个文件大小上限", en: "Largest file in a snapshot" },
					help: {
						zh: "更大的文件不进快照，回退时也绝不动它。",
						en: "Larger files stay out of snapshots, and a rewind never touches them.",
					},
					unit: { zh: "MB", en: "MB" },
				},
				{
					key: "ignore",
					kind: "list",
					default: [],
					label: { zh: "额外忽略的路径", en: "Extra paths to ignore" },
					help: {
						zh: "gitignore 写法，一行一条。项目自己的 .gitignore 和内置清单（node_modules、构建产物等）始终生效。",
						en: "gitignore patterns, one per line. The project's own .gitignore and the built-in list (node_modules, build outputs and so on) always apply.",
					},
				},
				{
					key: "timeoutMs",
					kind: "number",
					default: 30000,
					min: 1000,
					max: 600000,
					label: { zh: "单次快照最长用时", en: "Longest a snapshot may take" },
					help: {
						zh: "超时则本回合不拍快照，工具照常执行。",
						en: "Past this the turn goes without a checkpoint; the tool call still runs.",
					},
					unit: ms,
				},
				{
					key: "propose",
					kind: "boolean",
					default: true,
					label: { zh: "发现死路时提议回退", en: "Propose a rewind at a dead end" },
				},
				{
					key: "confirmSeconds",
					kind: "number",
					default: 120,
					min: 0,
					max: 3600,
					label: { zh: "提议等待你回答的时间", en: "How long a proposal waits for you" },
					help: {
						zh: "到时未答就继续原来的工作。0 表示一直等。",
						en: "Unanswered, the run carries on. 0 waits forever.",
					},
					unit: { zh: "秒", en: "s" },
				},
			],
		},
		{
			name: "monitor",
			title: { zh: "跑偏监测", en: "Drift monitor" },
			summary: { zh: "发现偏离目标和原地打转。", en: "Notices drift from the goal and going in circles." },
			defaultEnabled: true,
			options: [
				{
					key: "every",
					kind: "number",
					default: 6,
					min: 1,
					max: 100,
					label: { zh: "每隔几次工具调用检查", en: "Check every this many tool calls" },
				},
				{
					key: "repeats",
					kind: "number",
					default: 3,
					min: 2,
					max: 20,
					label: { zh: "同一调用重复几次算打转", en: "Repeats that count as a loop" },
				},
				{ key: "window", kind: "number", default: 8, min: 2, max: 100, label: { zh: "观察窗口", en: "Window" } },
			],
		},
		{
			name: "ttsr",
			title: { zh: "写偏即停（实验）", en: "Mid-stream correction (experiment)" },
			summary: {
				zh: "语义版 TTSR：不用正则，而由判定器发现模型写偏，中断输出、摆出规则、从原处继续。默认关闭；开启后每隔一段输出就会多一次判定调用。",
				en: "Semantic TTSR: the judge, not a regular expression, notices the output going astray, cuts it, shows the rule and lets the model carry on. Off by default; when on, every stretch of output costs one more judge call.",
			},
			defaultEnabled: false,
			options: [
				{
					key: "rules",
					kind: "list",
					default: [],
					label: { zh: "一直要守的规则", en: "Rules to hold at all times" },
					help: {
						zh: "一行一条，用平常的话写，例如“用中文回答”“不要写占位实现”。任务帧里你的硬约束会自动加入，不必重复。",
						en: "One per line, in plain words, e.g. “Answer in Chinese”, “No placeholder implementations”. Your hard constraints from the task frame are added automatically.",
					},
				},
				{
					key: "segmentChars",
					kind: "number",
					default: 600,
					min: 200,
					max: 5000,
					label: { zh: "每输出多少字符判一次", en: "Characters of output per check" },
				},
				{
					key: "maxRules",
					kind: "number",
					default: 4,
					min: 1,
					max: 12,
					label: { zh: "每次最多对照的规则条数", en: "Rules checked per call at most" },
					help: { zh: "超出时保留你最近说的。", en: "When there are more, the ones you said last stay." },
				},
				{
					key: "maxInterrupts",
					kind: "number",
					default: 2,
					min: 1,
					max: 10,
					label: { zh: "两次发言之间最多中断几次", en: "Cuts at most between two of your messages" },
				},
			],
		},
		{
			name: "goal",
			title: { zh: "目标模式", en: "Goal mode" },
			summary: {
				zh: "/goal <条件> 之后，代理会一直干到条件成立为止。被你打断、模型调用失败、连续空转、用完续跑次数或时间，都会自己停下；你再发一条消息就接着干。",
				en: "After /goal <condition> the agent keeps working until the condition holds. It stops by itself when you interrupt, a model call fails, it idles, or its allowance runs out; your next message picks it up again.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "maxContinuations",
					kind: "number",
					default: 20,
					min: 1,
					max: 200,
					label: { zh: "最多自动续跑次数", en: "Continuations at most" },
					help: { zh: "从你上一次发言算起。", en: "Counted from your last message." },
				},
				{
					key: "maxMinutes",
					kind: "number",
					default: 180,
					min: 5,
					max: 1440,
					label: { zh: "最长自动运行（分钟）", en: "Minutes at most" },
					help: { zh: "从你上一次发言算起。", en: "Counted from your last message." },
				},
				{
					key: "idleLimit",
					kind: "number",
					default: 2,
					min: 1,
					max: 10,
					label: { zh: "连续空转几次就停", en: "Idle runs before it stops" },
					help: {
						zh: "模型连续几次什么工具都没用就结束，说明它在原地打转。",
						en: "Runs in a row that ended without a single tool call: the agent is going nowhere.",
					},
				},
			],
		},
		{
			name: "completion",
			title: { zh: "完成核对", en: "Completion check" },
			summary: {
				zh: "“做完了”之前确认有没有验证过。",
				en: "Checks that something verified the work before it is called done.",
			},
			defaultEnabled: true,
			options: [],
		},
		{
			name: "notify",
			title: { zh: "通知分流", en: "Notification routing" },
			summary: { zh: "决定各类事件何时告诉模型。", en: "Decides when events are told to the model." },
			defaultEnabled: true,
			options: [
				{
					key: "budgetThresholds",
					kind: "numbers",
					default: [70, 85],
					label: { zh: "上下文预算提醒（%）", en: "Context budget notices (%)" },
				},
			],
		},
		{
			name: "warming",
			title: { zh: "缓存保温", en: "Cache warming" },
			summary: {
				zh: "在提示词缓存过期前视情况续一下。",
				en: "Refreshes the prompt cache before it expires when that pays off.",
			},
			defaultEnabled: true,
			options: [],
		},
		{
			name: "swarm",
			title: { zh: "子代理", en: "Sub-agents" },
			summary: { zh: "把任务委派给按角色分工的子代理。", en: "Delegates tasks to sub-agents with roles." },
			defaultEnabled: true,
			options: [
				{
					key: "models",
					kind: "list",
					default: [],
					label: { zh: "模型梯队（从便宜到强）", en: "Model ladder (cheapest to strongest)" },
					help: {
						zh: "留空则子代理都用当前会话的模型。",
						en: "Empty means every sub-agent uses the session's model.",
					},
				},
				{
					key: "maxTasks",
					kind: "number",
					default: 6,
					min: 1,
					max: 32,
					label: { zh: "一次最多委派", en: "Tasks per call at most" },
				},
				{
					key: "concurrency",
					kind: "number",
					default: 3,
					min: 1,
					max: 16,
					label: { zh: "同时运行", en: "Running at once" },
				},
				{ key: "defaultAgent", kind: "text", default: "worker", label: { zh: "默认角色", en: "Default role" } },
				{
					key: "agentsDir",
					kind: "text",
					default: "",
					label: { zh: "自定义角色目录", en: "Folder with your own roles" },
					help: { zh: "留空使用 <agent 目录>/agents。", en: "Empty uses <agent dir>/agents." },
				},
			],
		},
		{
			name: "hive",
			title: { zh: "蜂群", en: "Hive" },
			summary: {
				zh: "多只蜂并行攻一个难题，判定器把关它们之间传什么。",
				en: "Several bees work one hard task in parallel; the judge gates what passes between them.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "maxNotesPerBee",
					kind: "number",
					default: 12,
					min: 1,
					max: 100,
					label: { zh: "每只蜂最多发布", en: "Notes per bee at most" },
				},
				{
					key: "maxDeliveriesPerBee",
					kind: "number",
					default: 10,
					min: 1,
					max: 100,
					label: { zh: "每只蜂最多收到", en: "Deliveries per bee at most" },
				},
				{
					key: "checkpointEvery",
					kind: "number",
					default: 4,
					min: 0,
					max: 50,
					label: { zh: "沉默几次工具调用后询问进展", en: "Ask for findings after this many silent tool calls" },
					help: { zh: "0 表示不询问。", en: "0 turns this off." },
				},
				{
					key: "lastCall",
					kind: "boolean",
					default: true,
					label: { zh: "写报告时再听一次新消息", en: "One last hearing while writing the report" },
				},
			],
		},
		{
			name: "locate",
			title: { zh: "文件定位", en: "File location" },
			summary: { zh: "用描述找文件的 locate 工具。", en: "The locate tool: find files by description." },
			defaultEnabled: true,
			options: [
				{
					key: "candidates",
					kind: "number",
					default: 40,
					min: 5,
					max: 400,
					label: { zh: "送判的候选数", en: "Candidates judged" },
				},
				{
					key: "results",
					kind: "number",
					default: 12,
					min: 1,
					max: 100,
					label: { zh: "返回条数", en: "Results returned" },
				},
			],
		},
		{
			name: "browser",
			title: { zh: "内置浏览器", en: "Built-in browser" },
			summary: {
				zh: "判定器驱动的浏览器，用自己独立的配置目录，从不动你的浏览器。",
				en: "A judge-driven browser with its own profile; it never touches yours.",
			},
			defaultEnabled: true,
			options: [
				{ key: "headless", kind: "boolean", default: true, label: { zh: "无界面运行", en: "Run headless" } },
				{
					key: "maxSteps",
					kind: "number",
					default: 40,
					min: 1,
					max: 200,
					label: { zh: "每次最多步数", en: "Steps per run at most" },
				},
				{
					key: "textChars",
					kind: "number",
					default: 4000,
					min: 500,
					max: 50000,
					unit: chars,
					label: { zh: "每步读取的页面文字", en: "Page text read per step" },
				},
				{
					key: "embedded",
					kind: "boolean",
					default: true,
					label: {
						zh: "桌面端运行时使用应用内的浏览器面板",
						en: "Use the desktop app's browser panel when it is running",
					},
					help: {
						zh: "这样每一步都看得见，可以随时暂停、停止或接管；应用没开时用 mu 自己的浏览器。",
						en: "Every step is then visible and can be paused, stopped or taken over; without the app mu's own browser is used.",
					},
				},
				{
					key: "profileDir",
					kind: "text",
					default: "",
					label: { zh: "浏览器配置目录", en: "Browser profile folder" },
					help: { zh: "留空使用 mu 自己的目录。", en: "Empty uses mu's own folder." },
				},
			],
		},
		{
			name: "welcome",
			title: { zh: "欢迎页", en: "Welcome screen" },
			summary: { zh: "终端里的欢迎框和身份说明。", en: "The welcome box in the terminal and the identity note." },
			defaultEnabled: true,
			options: [],
		},
		{
			name: "inherit",
			title: { zh: "沿用已有配置", en: "Inherit existing setup" },
			summary: {
				zh: "首次运行就沿用你给 Claude Code、Cursor、Codex 配好的规则、技能和 MCP 服务器，只读不写。常驻规则进提示词；按文件匹配的规则只在碰到匹配文件时随工具结果交给模型一次；其余规则只列描述。项目里的内容只在项目受信任时才用。",
				en: "Uses the rules, skills and MCP servers you already set up for Claude Code, Cursor and Codex, read-only. Always-on rules join the prompt; a rule scoped to file patterns is handed over once, with the result of the first tool that touches a matching file; the rest are listed by description. Project content is only used for a trusted project.",
			},
			defaultEnabled: true,
			options: [
				{
					key: "claude",
					kind: "boolean",
					default: true,
					label: { zh: "来自 Claude Code", en: "From Claude Code" },
				},
				{ key: "cursor", kind: "boolean", default: true, label: { zh: "来自 Cursor", en: "From Cursor" } },
				{ key: "codex", kind: "boolean", default: true, label: { zh: "来自 Codex", en: "From Codex" } },
				{ key: "rules", kind: "boolean", default: true, label: { zh: "沿用规则", en: "Inherit rules" } },
				{ key: "skills", kind: "boolean", default: true, label: { zh: "沿用技能", en: "Inherit skills" } },
				{
					key: "mcp",
					kind: "boolean",
					default: true,
					label: { zh: "沿用 MCP 服务器", en: "Inherit MCP servers" },
					help: {
						zh: "关掉后只用 mu.json 里 mcp.servers 自己定义的服务器。",
						en: "When off, only the servers under mcp.servers in mu.json are used.",
					},
				},
				{
					key: "maxRuleChars",
					kind: "number",
					default: 4000,
					min: 500,
					max: 20000,
					unit: chars,
					label: { zh: "单条按文件规则最多交给模型", en: "Most of one file-scoped rule handed over" },
					help: {
						zh: "超出的部分留在文件里，模型可以自己去读。",
						en: "The rest stays in the file for the model to read.",
					},
				},
				{
					key: "maxAlwaysChars",
					kind: "number",
					default: 16000,
					min: 0,
					max: 100000,
					unit: chars,
					label: { zh: "常驻规则总量上限", en: "Budget for always-on rules" },
					help: {
						zh: "放不下的常驻规则改为只列描述，避免提示词被规则撑大。",
						en: "Always-on rules that do not fit are listed by description instead, so rules cannot bloat the prompt.",
					},
				},
			],
		},
		{
			name: "mcp",
			title: { zh: "MCP 服务器", en: "MCP servers" },
			summary: {
				zh: '内置的 MCP 客户端（stdio 与 Streamable HTTP）。每个服务器是能力目录里的一项，默认隐藏：Jev 认定任务需要，或模型用 find_capability 要，才启动进程并注册它的工具。工具清单会缓存，服务器没跑过 Jev 也有描述可判。项目里定义的服务器第一次启动前要你点头，定义变了会再问。在 mu.json 的 mcp.servers 里给服务器写 "exposure": "always" 可以让它常开。',
				en: 'A built-in MCP client (stdio and Streamable HTTP). Each server is a catalog entry that stays hidden: its process starts and its tools register only when the judge finds the task needs it or the model asks through find_capability. Tool lists are cached, so the judge has a description before a server ever ran. A server defined by a project asks before its first start, and again when its definition changes. "exposure": "always" under mcp.servers in mu.json keeps a server open.',
			},
			defaultEnabled: true,
			options: [
				{
					key: "startTimeoutMs",
					kind: "number",
					default: 45000,
					min: 1000,
					max: 300000,
					unit: ms,
					label: { zh: "启动最多等待", en: "Start timeout" },
					help: { zh: "npx 一类的服务器第一次要先下载自己。", en: "An npx-style server downloads itself first." },
				},
				{
					key: "requestTimeoutMs",
					kind: "number",
					default: 120000,
					min: 1000,
					max: 3600000,
					unit: ms,
					label: { zh: "单次调用最多等待", en: "Call timeout" },
				},
				{
					key: "waitMs",
					kind: "number",
					default: 8000,
					min: 0,
					max: 60000,
					unit: ms,
					label: { zh: "回合开始前最多等常开服务器", en: "Wait for pinned servers before a turn" },
				},
				{
					key: "maxResultChars",
					kind: "number",
					default: 60000,
					min: 2000,
					max: 1000000,
					unit: chars,
					label: { zh: "单个结果最多进上下文", en: "Most of one result kept in context" },
					help: {
						zh: "超出的部分截掉，完整结果存到文件。",
						en: "The rest is cut and the whole result saved to a file.",
					},
				},
			],
		},
	],
};
