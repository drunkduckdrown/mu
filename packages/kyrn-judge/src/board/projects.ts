import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Which projects have the plain-language board on, in `<agentDir>/mu/board.json`.
 * The switch is per project and belongs to the user: a repository cannot
 * turn it on for itself (mu reads no settings from a project), because every
 * update of the board costs a model call. Without a directory (tests,
 * embedding) the switches live in memory.
 */
interface BoardFile {
	version: 1;
	projects: Record<string, boolean>;
}

export class BoardProjects {
	private readonly file: string | undefined;
	private memory: Record<string, boolean> = {};

	constructor(dir: string | undefined) {
		this.file = dir ? join(dir, "board.json") : undefined;
	}

	private read(): Record<string, boolean> {
		if (!this.file) return this.memory;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<BoardFile>;
			return parsed.version === 1 && typeof parsed.projects === "object" && parsed.projects !== null
				? parsed.projects
				: {};
		} catch {
			return {};
		}
	}

	/** On or off for this project, or undefined when nobody switched it. */
	get(cwd: string): boolean | undefined {
		const value = this.read()[resolve(cwd)];
		return typeof value === "boolean" ? value : undefined;
	}

	set(cwd: string, on: boolean): void {
		const projects = { ...this.read(), [resolve(cwd)]: on };
		if (!this.file) {
			this.memory = projects;
			return;
		}
		mkdirSync(join(this.file, ".."), { recursive: true });
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, projects } satisfies BoardFile, null, "\t")}\n`, {
			mode: 0o600,
		});
		renameSync(temporary, this.file);
	}
}
