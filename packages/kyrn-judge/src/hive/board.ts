import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

/**
 * The hive's shared board: an append-only file every bee can write to and
 * read from. Bees never talk to each other directly; what one of them found
 * reaches the others only through here, and only after the judge let it.
 */
export type NoteKind = "finding" | "dead_end" | "decision" | "blocker";

export interface Note {
	readonly id: string;
	/** Who posted it. */
	readonly bee: string;
	readonly kind: NoteKind;
	/** The judge's probability that others need this. */
	readonly score: number;
	/** Word for word what the bee said or saw. Nothing is paraphrased on the way. */
	readonly text: string;
	/** Where it came from: "said", or the tool call that produced it. */
	readonly source: string;
	readonly at: string;
}

export interface Delivery {
	readonly note: string;
	readonly to: string;
	readonly score: number;
}

const BOARD = "board.jsonl";
const DELIVERIES = "deliveries.jsonl";

function parseLines<T>(text: string): T[] {
	const rows: T[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line) as T);
		} catch {
			// A torn line from a concurrent writer is skipped, not fatal.
		}
	}
	return rows;
}

/** Reads what was appended since `offset`, up to the last complete line. */
function readFrom<T>(path: string, offset: number): { rows: T[]; offset: number } {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return { rows: [], offset };
	}
	try {
		const size = fstatSync(fd).size;
		if (size <= offset) return { rows: [], offset };
		const buffer = Buffer.alloc(size - offset);
		readSync(fd, buffer, 0, buffer.length, offset);
		const text = buffer.toString("utf8");
		const complete = text.lastIndexOf("\n") + 1;
		return {
			rows: parseLines<T>(text.slice(0, complete)),
			offset: offset + Buffer.byteLength(text.slice(0, complete)),
		};
	} finally {
		closeSync(fd);
	}
}

export class Board {
	readonly dir: string;
	private offset = 0;

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	post(note: Note): void {
		appendFileSync(join(this.dir, BOARD), `${JSON.stringify(note)}\n`);
	}

	/** Notes appended since the last call on this instance. */
	fresh(): Note[] {
		const read = readFrom<Note>(join(this.dir, BOARD), this.offset);
		this.offset = read.offset;
		return read.rows;
	}

	all(): Note[] {
		return readFrom<Note>(join(this.dir, BOARD), 0).rows;
	}

	delivered(delivery: Delivery): void {
		appendFileSync(join(this.dir, DELIVERIES), `${JSON.stringify(delivery)}\n`);
	}

	/** Every verdict of the gates, passed or not: the answer to "why did nobody hear about this?". */
	log(entry: Readonly<Record<string, unknown>>): void {
		appendFileSync(join(this.dir, "gate.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
	}

	deliveries(): Delivery[] {
		return readFrom<Delivery>(join(this.dir, DELIVERIES), 0).rows;
	}

	private gateOffset = 0;
	private gateRows = 0;

	/** How many verdicts the gates have given so far. Counted incrementally: the log only grows. */
	judged(): number {
		const read = readFrom<unknown>(join(this.dir, "gate.jsonl"), this.gateOffset);
		this.gateOffset = read.offset;
		this.gateRows += read.rows.length;
		return this.gateRows;
	}
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []);

/** Rules before the judge: a note that says what the board already says is not news. */
export function isDuplicate(text: string, notes: readonly Pick<Note, "text">[], overlap = 0.8): boolean {
	const mine = words(text);
	if (mine.size === 0) return true;
	return notes.some((note) => {
		const theirs = words(note.text);
		let shared = 0;
		for (const word of mine) if (theirs.has(word)) shared++;
		return shared / mine.size >= overlap;
	});
}
