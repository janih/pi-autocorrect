/**
 * Dictionary loading for pi-dev-autocorrect.
 *
 * Pure Node — no dependency on the pi runtime, so it can be unit-tested
 * directly with `node --test`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the extension (directory containing index.ts / dict/). */
export const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export class Dictionary {
	private readonly words = new Set<string>();
	private wordList: string[] | undefined;
	readonly sourceLabels: string[] = [];

	/** Read a one-word-per-line file (# prefix = comment). Case-insensitive. */
	addFile(path: string, label: string): boolean {
		if (!existsSync(path)) return false;
		const text = readFileSync(path, "utf8");
		let count = 0;
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			this.words.add(line.toLowerCase());
			count++;
		}
		this.sourceLabels.push(`${label}: ${count.toLocaleString()}`);
		this.wordList = undefined;
		return true;
	}

	addWords(words: Iterable<string>): void {
		for (const w of words) {
			if (w) this.words.add(w.toLowerCase());
		}
		this.wordList = undefined;
	}

	has(word: string): boolean {
		return this.words.has(word.toLowerCase());
	}

	get size(): number {
		return this.words.size;
	}

	/** Flat list for suggestion scans (built lazily). */
	list(): string[] {
		if (!this.wordList) this.wordList = [...this.words];
		return this.wordList;
	}
}

export interface LoadOptions {
	/** Extra personal words (e.g. from the user config file). */
	userWords?: Iterable<string>;
}

/** Build the full dictionary: British English + tech words + custom + personal. */
export function loadDictionary(options: LoadOptions = {}): Dictionary {
	const dict = new Dictionary();
	dict.addFile(join(EXTENSION_ROOT, "dict", "british-english"), "british-english");
	dict.addFile(join(EXTENSION_ROOT, "dict", "tech-words.txt"), "tech-words");
	dict.addFile(join(EXTENSION_ROOT, "dict", "custom-words.txt"), "custom-words");
	if (options.userWords) dict.addWords(options.userWords);
	return dict;
}
