import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Real git on a real temporary repository: the plumbing under test is git's behaviour, so nothing of it is mocked. */
export function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.safecrlf=false", ...args], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			LC_ALL: "C",
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

/** A temp area whose path has a space and Chinese characters in it, like a Windows profile can. Remove `root` afterwards. */
export function tempArea(prefix = "kyrn-wt-test-"): { root: string; dir: string } {
	// realpath: git reports /private/var on macOS where tmpdir() says /var.
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	const dir = join(root, "临时 区");
	mkdirSync(dir);
	return { root, dir };
}

/** Turns `repo` into a repository with one commit holding `files`. */
export function initRepo(
	repo: string,
	files: Record<string, string | Buffer>,
	config: Record<string, string> = {},
): string {
	mkdirSync(repo, { recursive: true });
	sh(repo, "init", "-q", "-b", "main", ".");
	for (const [key, value] of Object.entries(config)) sh(repo, "config", key, value);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
	sh(repo, "add", "-A");
	sh(repo, "commit", "-qm", "init");
	return repo;
}

export function makeRepo(
	parent: string,
	files: Record<string, string | Buffer>,
	config: Record<string, string> = {},
): string {
	return initRepo(join(parent, "我的 repo"), files, config);
}
