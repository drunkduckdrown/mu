import { Type } from "typebox";
import { skillDisclosure } from "../../decisions/skill-disclosure.ts";
import { failOpen, type KyrnRuntime } from "../runtime.ts";

interface HiddenSkill {
	name: string;
	description: string;
	filePath: string;
	announced: boolean;
}

/**
 * A6: the first message of a session decides which skill descriptions the
 * system prompt carries, and that set then stays fixed so the cached prefix
 * survives. A hidden skill that becomes relevant later is announced in a
 * message instead of being put back into the prompt.
 */
export function registerSkills(runtime: KyrnRuntime): void {
	const options = runtime.options("skills", { enabled: true, minSkills: 4, waitMs: 4000 });
	if (!options.enabled) return;
	const { pi } = runtime;
	const hidden = new Map<string, HiddenSkill>();
	let decided = false;

	pi.on(
		"before_agent_start",
		failOpen(async (event, ctx) => {
			runtime.touch(ctx);
			const mode = runtime.mode(skillDisclosure.id);
			const all = event.systemPromptOptions.skills ?? [];
			const visible = all.filter((skill) => !skill.disableModelInvocation);
			if (mode === "off" || visible.length < options.minSkills) return undefined;

			const bounded = <T>(work: Promise<T>): Promise<T | undefined> =>
				Promise.race([
					work,
					new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), options.waitMs)),
				]);

			if (!decided) {
				decided = true;
				runtime.progress("choosing which skills this session needs");
				const decision = await bounded(
					runtime.engine.decide(
						skillDisclosure,
						{ userMessage: event.prompt, skills: visible },
						{ signal: ctx.signal },
					),
				);
				if (decision?.source === "judge") {
					for (const skill of visible) {
						if (decision.outcome.hide.includes(skill.name)) {
							hidden.set(skill.name, { ...skill, announced: false });
							runtime.savings.skillsHiddenChars +=
								skill.name.length + skill.description.length + skill.filePath.length;
						}
					}
				}
			}
			if (hidden.size === 0) return undefined;

			// Same set on every turn: the prompt prefix must not move once it has been cached.
			event.systemPromptOptions.skills = all.filter((skill) => !hidden.has(skill.name));

			if (runtime.userTurns <= 1) return undefined;
			const candidates = [...hidden.values()].filter((skill) => !skill.announced);
			if (candidates.length === 0) return undefined;
			const again = await bounded(
				runtime.engine.decide(
					skillDisclosure,
					{ userMessage: event.prompt, skills: candidates },
					{ signal: ctx.signal },
				),
			);
			if (again?.source !== "judge" || again.outcome.relevant.length === 0) return undefined;
			const lines: string[] = [];
			for (const name of again.outcome.relevant) {
				const skill = hidden.get(name);
				if (!skill) continue;
				skill.announced = true;
				lines.push(`- ${skill.name}: ${skill.description} (read ${skill.filePath} to use it)`);
			}
			return {
				message: {
					customType: "kyrn.skills",
					content: `Skills that may help with this request:\n${lines.join("\n")}`,
					display: true,
				},
			};
		}),
	);

	pi.registerTool({
		name: "find_skill",
		label: "Find skill",
		description:
			"List installed skills that are not shown in the system prompt. Use it when a task needs a capability you have no skill for.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Words to look for in skill names and descriptions" })),
		}),
		execute: async (_toolCallId, params) => {
			const words = (params.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
			const matches = [...hidden.values()].filter((skill) => {
				const text = `${skill.name} ${skill.description}`.toLowerCase();
				return words.length === 0 || words.some((word) => text.includes(word));
			});
			const text =
				matches.length === 0
					? "No hidden skills match."
					: matches
							.map((skill) => `- ${skill.name}: ${skill.description} (read ${skill.filePath} to use it)`)
							.join("\n");
			return { content: [{ type: "text", text }], details: { matches: matches.map((skill) => skill.name) } };
		},
	});
}
