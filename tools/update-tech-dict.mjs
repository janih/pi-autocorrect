#!/usr/bin/env node
/**
 * Sync the technical word list from the cspell-dicts project (MIT licensed).
 *
 * Downloads curated plain-text word lists from
 * https://github.com/streetsidesoftware/cspell-dicts and merges them into
 * dict/tech-words.txt (one lowercase word per line, sorted, deduplicated).
 *
 * Usage:  npm run update-dicts   (or: node tools/update-tech-dict.mjs)
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAW = "https://raw.githubusercontent.com/streetsidesoftware/cspell-dicts/main/dictionaries/";

/** [source name, candidate file paths (tried in order, 404s skipped)] */
const SOURCES = [
	["software-terms", ["software-terms/src/software-terms.txt", "software-terms/src/coding-terms.txt", "software-terms/src/computing-acronyms.txt", "software-terms/src/software-tools.txt", "software-terms/src/software-services.txt"]],
	["git", ["git/src/terms.txt", "git/src/additional_words.txt"]],
	["docker", ["docker/src/docker-words.txt"]],
	["node", ["node/src/node.txt"]],
	["typescript", ["typescript/src/typescript.txt"]],
	["python", ["python/src/additional_words.txt", "python/src/common_packages.txt", "python/src/data_science.txt", "python/src/common/extra.txt"]],
	["golang", ["golang/src/go.txt", "golang/src/additional-terms.txt", "golang/src/allowed-terms.txt"]],
	["shell", ["shell/src/shell-bash-words.txt", "shell/src/shell-zsh-words.txt", "shell/src/command-words.txt", "shell/src/miscellaneous-words.txt"]],
	["aws", ["aws/src/aws.txt"]],
	["companies", ["companies/src/companies.txt"]],
];

const HEADER = `# Technical word list for pi-autocorrect.
# GENERATED FILE — do not edit by hand; run \`npm run update-dicts\` instead.
# Derived from https://github.com/streetsidesoftware/cspell-dicts (MIT license).
# Hand-picked personal additions belong in dict/custom-words.txt.
`;

function normalizeLine(line) {
	// Strip cspell inline comments and forbidden-word markers.
	let w = line.split("#")[0].trim();
	if (!w || w.startsWith("!")) return [];
	return (
		w
			.split(/\s+/) // multi-word entries: keep the individual words
			.map((t) => t.replace(/['’]s$/i, "")) // strip possessives
			.map((t) => t.toLowerCase())
			// plain-letter words only (the tokenizer skips digit/mixed tokens anyway)
			.filter((t) => /^[a-z]['’a-z-]{1,29}$/.test(t))
	);
}

async function fetchLines(url) {
	const res = await fetch(url);
	if (res.status === 404) return null; // upstream moved/renamed: skip quietly
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
	const text = await res.text();
	return text.split(/\r?\n/).flatMap(normalizeLine);
}

const words = new Set();
const report = [];

for (const [name, files] of SOURCES) {
	let added = 0;
	for (const file of files) {
		const lines = await fetchLines(RAW + file);
		if (lines === null) {
			console.warn(`  skip (404): ${file}`);
			continue;
		}
		for (const w of lines) {
			if (!words.has(w)) {
				words.add(w);
				added++;
			}
		}
	}
	report.push(`${name.padEnd(15)} +${added}`);
}

const out = HEADER + [...words].sort().join("\n") + "\n";
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dict", "tech-words.txt");
await writeFile(outPath, out, "utf8");

console.log("Sources merged:");
for (const line of report) console.log("  " + line);
console.log(`\nWrote ${words.size} unique words to ${outPath}`);
