/**
 * Spell-checking engine for pi-autocorrect.
 *
 * Code-aware tokenizer + Damerau-Levenshtein suggestion engine.
 * Pure TypeScript — no dependency on the pi runtime.
 */

import type { Dictionary } from "./dictionary.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Issue {
	/** Exact text as it appears in the input (case-preserved). */
	word: string;
	/** Character offset of the word in the original text. */
	start: number;
	end: number;
	/** Ranked replacement suggestions (best first, may be empty). */
	suggestions: string[];
}

export interface Fix {
	start: number;
	end: number;
	original: string;
	replacement: string;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g;

/** Most frequent English words — used to break suggestion ties sensibly. */
const COMMON = new Set(
	("the be to of and a in that have it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us was were has had are " +
		"receive environment separate definitely occurred beginning committee government independent necessary opportunity paragraph privilege question recommend schedule their there until weight write")
		.split(/\s+/),
);

/** Mark character ranges that must never be spell-checked. */
function protectedRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const add = (re: RegExp) => {
		for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
	};

	// Fenced code blocks (``` or ~~~)
	const fenceRe = /^[ \t]*(```|~~~)/gm;
	let open: { index: number; marker: string } | undefined;
	for (const m of text.matchAll(fenceRe)) {
		if (!open) {
			open = { index: m.index, marker: m[1] };
		} else if (m[1][0] === open.marker[0]) {
			ranges.push([open.index, m.index + m[0].length]);
			open = undefined;
		}
	}
	if (open) ranges.push([open.index, text.length]);

	// Inline code spans
	add(/`[^`\n]+`/g);
	// URLs, www hosts, e-mail addresses
	add(/\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>()]+/gi);
	add(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g);
	// File paths: anything with a slash glued to non-space tokens
	add(/[^\s()<>]*\/[^\s()<>]*/g);
	// @handles
	add(/(?<![\w])@[A-Za-z][\w-]+\b/g);
	return ranges;
}

function inProtected(pos: number, ranges: Array<[number, number]>): boolean {
	for (const [start, end] of ranges) if (pos >= start && pos < end) return true;
	return false;
}

/** Strip possessives and edge apostrophes; returns the lookup base. */
function baseForm(word: string): string {
	let w = word.replace(/^['’]+|['’]+$/g, "");
	if (/['’]s$/i.test(w)) w = w.slice(0, -2);
	return w.toLowerCase();
}

export interface Token {
	text: string;
	start: number;
	end: number;
	/** Whether this token should be checked. */
	check: boolean;
}

/**
 * Split text into word tokens, marking which ones are checkable prose.
 * Skips: protected regions (code/URLs/paths), flags (--x), identifier-adjacent
 * tokens (snake_case, file.ext), mixedCase, ALLCAPS, and very short words.
 */
export function tokenize(text: string): Token[] {
	const ranges = protectedRanges(text);
	const tokens: Token[] = [];
	for (const m of text.matchAll(WORD_RE)) {
		const word = m[0];
		const start = m.index;
		const end = start + word.length;
		const token: Token = { text: word, start, end, check: false };

		const prev = start > 0 ? text[start - 1] : "";
		const next = end < text.length ? text[end] : "";

		if (!inProtected(start, ranges)) {
			if (word.length >= 3) {
				const identifierAdjacency =
					prev === "_" || next === "_" || prev === "/" || prev === "-" || prev === "." || next === ".";
				const mixedCase = /[A-Z]/.test(word.slice(1));
				const allCaps = word === word.toUpperCase(); // CONSTANT_STYLE / acronyms
				if (!identifierAdjacency && !mixedCase && !allCaps) {
					token.check = true;
				}
			}
		}
		tokens.push(token);
	}
	return tokens;
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

function hyphenParts(word: string): string[] {
	return baseForm(word)
		.split("-")
		.filter((p) => p.length >= 2);
}

function isKnown(token: Token, dict: Dictionary): boolean {
	const base = baseForm(token.text);
	if (!base) return true;
	if (base.includes("-")) {
		const parts = hyphenParts(token.text);
		return parts.every((p) => dict.has(p));
	}
	return dict.has(base);
}

/** Check text; returns misspelled-word issues in document order. */
export function checkText(text: string, dict: Dictionary): Issue[] {
	const issues: Issue[] = [];
	for (const token of tokenize(text)) {
		if (!token.check) continue;
		if (isKnown(token, dict)) continue;
		issues.push({
			word: token.text,
			start: token.start,
			end: token.end,
			suggestions: suggest(token.text, dict),
		});
	}
	return issues;
}

// ---------------------------------------------------------------------------
// Suggestions (Damerau-Levenshtein, optimal string alignment)
// ---------------------------------------------------------------------------

/** OSA edit distance with early cutoff. Returns >cutoff if no path found. */
export function editDistance(a: string, b: string, cutoff: number): number {
	if (a === b) return 0;
	const alen = a.length;
	const blen = b.length;
	if (Math.abs(alen - blen) > cutoff) return cutoff + 1;

	let prevPrev: number[] | undefined;
	let prev = Array.from({ length: blen + 1 }, (_, j) => j);

	for (let i = 1; i <= alen; i++) {
		// Fresh row buffer: a reused/rotated scratch would alias prevPrev and
		// corrupt the row the transposition check reads.
		const curr = new Array<number>(blen + 1);
		curr[0] = i;
		let rowMin = curr[0];
		const ca = a.charCodeAt(i - 1);
		const iStart = Math.max(1, i - cutoff);
		const iEnd = Math.min(blen, i + cutoff);
		for (let j = 1; j <= blen; j++) {
			if (j < iStart || j > iEnd) {
				curr[j] = cutoff + 1;
				continue;
			}
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
			if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
				v = Math.min(v, (prevPrev as number[])[j - 2] + 1);
			}
			curr[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > cutoff) return cutoff + 1;
		prevPrev = prev;
		prev = curr;
	}
	return prev[blen] <= cutoff ? prev[blen] : cutoff + 1;
}

/** Apply the case pattern of the flagged word to a suggestion. */
function matchCase(flagged: string, suggestion: string): string {
	const first = suggestion.charAt(0);
	if (first && /^[A-Z]/.test(flagged.charAt(0))) {
		return first.toUpperCase() + suggestion.slice(1);
	}
	return suggestion;
}

export function suggest(flagged: string, dict: Dictionary, max = 5): string[] {
	const base = baseForm(flagged);
	if (base.length < 2) return [];
	// Possessives: suggestions target the base; re-attach the stripped suffix.
	const stripped = flagged.toLowerCase().replace(/^['’]+|['’]+$/g, "");
	const suffix = stripped.startsWith(base) ? stripped.slice(base.length) : "";
	const cutoff = base.length <= 3 ? 1 : 2;

	type Cand = { word: string; dist: number; priority: boolean };
	const cands: Cand[] = [];
	for (const candidate of dict.list()) {
		if (Math.abs(candidate.length - base.length) > cutoff) continue;
		const dist = editDistance(base, candidate, cutoff);
		if (dist <= cutoff) cands.push({ word: candidate, dist, priority: COMMON.has(candidate) });
	}
	cands.sort(
		(x, y) =>
			x.dist - y.dist ||
			Number(y.priority) - Number(x.priority) ||
			Math.abs(x.word.length - base.length) - Math.abs(y.word.length - base.length) ||
			(x.word < y.word ? -1 : 1),
	);
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of cands) {
		if (seen.has(c.word)) continue;
		seen.add(c.word);
		out.push(matchCase(flagged, c.word) + suffix);
		if (out.length >= max) break;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Confident auto-fix selection
// ---------------------------------------------------------------------------

/**
 * Pick fixes that are safe to apply without asking.
 *
 * Candidates are grouped by (distance, length difference); the best group is
 * the closest distance, tie-broken by the smallest length difference. The fix
 * is confident when the best group has a single member, or its member is a
 * common word and no group rival is (e.g. "teh" -> "the" even though
 * "ten"/"tea" are also distance 1 — same length rules them out first).
 */
export function confidentFixes(issues: Issue[]): Fix[] {
	const fixes: Fix[] = [];
	for (const issue of issues) {
		const base = baseForm(issue.word);
		const cutoff = base.length <= 4 ? 1 : 2;
		const ranked = issue.suggestions;
		if (ranked.length === 0) continue;

		const cands = ranked
			.map((s) => {
				const lower = s.toLowerCase();
				return {
					word: lower,
					dist: editDistance(base, lower, cutoff),
					lenDiff: Math.abs(lower.length - base.length),
					common: COMMON.has(lower),
				};
			})
			.filter((c) => c.dist <= cutoff);
		if (cands.length === 0) continue;

		const bestDist = Math.min(...cands.map((c) => c.dist));
		const bestLenDiff = Math.min(...cands.filter((c) => c.dist === bestDist).map((c) => c.lenDiff));
		const group = cands.filter((c) => c.dist === bestDist && c.lenDiff === bestLenDiff);
		const best = group.find((c) => c.common) ?? group[0]; // suggestion order breaks remaining ties
		const confident =
			group.length === 1 ||
			(best.common && group.every((c) => c === best || !c.common) && (base.length > 3 || best.lenDiff === 0));
		if (!confident) continue;
		const replacement = issue.suggestions.find((s) => s.toLowerCase() === best.word) ?? issue.suggestions[0];
		fixes.push({ start: issue.start, end: issue.end, original: issue.word, replacement });
	}
	return fixes;
}

/** Issues that produced no confident fix (for accurate fix-mode reporting). */
export function unresolvedIssues(issues: Issue[], fixes: Fix[]): Issue[] {
	const fixed = new Set(fixes.map((f) => `${f.start}:${f.end}`));
	return issues.filter((i) => !fixed.has(`${i.start}:${i.end}`));
}

/** Apply fixes to text. Fixes must not overlap. */
export function applyFixes(text: string, fixes: Fix[]): string {
	const sorted = [...fixes].sort((a, b) => b.start - a.start);
	let result = text;
	for (const fix of sorted) {
		result = result.slice(0, fix.start) + fix.replacement + result.slice(fix.end);
	}
	return result;
}
