/**
 * pi-autocorrect — British-English spell checker / autocorrector for pi.
 *
 * Checks every prompt before it is sent and can:
 *   warn — show possible spelling mistakes (default)
 *   fix  — silently apply confident corrections and report them
 *   ask  — interactively confirm each correction
 *   off  — disable
 *
 * Code-aware: skips code spans/fences, URLs, e-mails, file paths, flags
 * (--like-this), snake_case/camelCase identifiers, ALL-CAPS constants and
 * possessive handling ("user's").
 *
 * Commands:
 *   /spell              check the current draft in the editor
 *   /spell-mode [mode]  switch mode (interactive picker without argument)
 *   /spell-add <word…>  add words to your personal dictionary
 *   /spell-remove <word…>
 *
 * Load with:  pi -e /path/to/pi-autocorrect
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Dictionary } from "./lib/dictionary.ts";
import { loadDictionary } from "./lib/dictionary.ts";
import type { Fix, Issue, Repetition, RepetitionGroup } from "./lib/spellcheck.ts";
import {
	applyFixes,
	checkText,
	confidentFixes,
	expandFix,
	findRepetitions,
	groupIssues,
	groupRepetitions,
	repetitionFix,
	repetitionGroupLabel,
	unresolvedIssues,
} from "./lib/spellcheck.ts";

// ---------------------------------------------------------------------------
// Configuration (persisted in ~/.pi/agent/pi-autocorrect.json)
// ---------------------------------------------------------------------------

type Mode = "off" | "warn" | "fix" | "ask";
const MODES: Mode[] = ["off", "warn", "fix", "ask"];
const DEFAULT_MODE: Mode = "warn";
const TYPE_OWN = "type a correction…";
const KEEP_ORIGINAL = "keep original";
const USE_ONCE = "use it once";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-autocorrect.json");

interface Config {
	mode: Mode;
	userWords: string[];
}

let config: Config = { mode: DEFAULT_MODE, userWords: [] };

function loadConfig(): void {
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
			config = {
				mode: MODES.includes(raw.mode as Mode) ? (raw.mode as Mode) : DEFAULT_MODE,
				userWords: Array.isArray(raw.userWords) ? raw.userWords.filter((w) => typeof w === "string") : [],
			};
		}
	} catch {
		config = { mode: DEFAULT_MODE, userWords: [] };
	}
}

function saveConfig(): void {
	try {
		mkdirSync(join(CONFIG_PATH, ".."), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n");
	} catch {
		// non-fatal: settings just won't persist
	}
}

// ---------------------------------------------------------------------------
// Dictionary (lazy singleton per extension runtime)
// ---------------------------------------------------------------------------

let dictionary: Dictionary | undefined;

function ensureDictionary(): Dictionary {
	if (!dictionary) {
		dictionary = loadDictionary({ userWords: config.userWords });
	}
	return dictionary;
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

const MAX_REPORT = 5;

/** "" for a single occurrence, " ×3" when the same word appears repeatedly. */
function times(count: number): string {
	return count > 1 ? ` ×${count}` : "";
}

/** Total issues, plus how many distinct words they cover when they differ. */
function countIssues(issues: Issue[]): string {
	const distinct = groupIssues(issues).length;
	return issues.length === distinct ? `${issues.length}` : `${issues.length} in ${distinct} words`;
}

/** One-line summary, one entry per distinct word: "recieve → receive ×2, xyzzy (?)" */
function summarizeIssues(issues: Issue[]): string {
	const groups = groupIssues(issues);
	const parts = groups.slice(0, MAX_REPORT).map(
		(g) => `${g.suggestions.length > 0 ? `${g.word} → ${g.suggestions[0]}` : `${g.word} (?)`}${times(g.occurrences.length)}`,
	);
	if (groups.length > MAX_REPORT) parts.push(`+${groups.length - MAX_REPORT} more`);
	return parts.join(", ");
}

function summarizeFixes(fixes: Fix[]): string {
	const groups = groupIssues(fixes.map((f) => ({ word: f.original, start: f.start, end: f.end, suggestions: [f.replacement] })));
	const parts = groups.slice(0, MAX_REPORT).map((g) => `${g.word} → ${g.suggestions[0]}${times(g.occurrences.length)}`);
	if (groups.length > MAX_REPORT) parts.push(`+${groups.length - MAX_REPORT} more`);
	return parts.join(", ");
}

function summarizeRepetitions(groups: RepetitionGroup[]): string {
	const parts = groups.slice(0, MAX_REPORT).map(repetitionGroupLabel);
	if (groups.length > MAX_REPORT) parts.push(`+${groups.length - MAX_REPORT} more`);
	return parts.join(", ");
}

/** Warning line for repeated words: "Repeated words: the ×2, and ×2 in 2 places" */
function repeatedWordsNotice(reps: Repetition[]): string {
	return `Repeated words: ${summarizeRepetitions(groupRepetitions(reps))}`;
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

export default function autocorrectExtension(pi: ExtensionAPI): void {
	loadConfig();

	const setStatus = (ui?: { setStatus(key: string, text: string | undefined): void } | undefined) => {
		if (!ui) return;
		ui.setStatus("spell", config.mode === "off" ? undefined : `spell:${config.mode}`);
	};

	pi.on("session_start", (_event, ctx) => setStatus(ctx.ui));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui?.setStatus("spell", undefined));

	/**
	 * Spelling issues plus repeated words. A misspelled repeat is left to the
	 * spelling pass: collapsing "tha tha" would guess at the intended meaning.
	 */
	const analyze = (text: string): { issues: Issue[]; reps: Repetition[] } => {
		const issues = checkText(text, ensureDictionary());
		const flagged = new Set(issues.map((i) => i.word.toLowerCase()));
		return { issues, reps: findRepetitions(text, flagged) };
	};

	/** Warn / fix / ask handling for one input text. Returns transformed text or undefined. */
	const processText = async (text: string, ctx: Pick<ExtensionContext, "hasUI" | "ui">): Promise<string | undefined> => {
		const { issues, reps } = analyze(text);
		if (issues.length === 0 && reps.length === 0) return undefined;

		const interactive = ctx.hasUI && config.mode === "ask";

		if (interactive) {
			// Ask mode: confirm one correction per distinct word and apply it to
			// every occurrence; keep anything the user declines.
			const groups = groupIssues(issues);
			const fixes: Fix[] = [];
			const MAX_ASK = 8;
			const asked = groups.slice(0, MAX_ASK);
			let beyond = groups.length - asked.length;
			for (const group of asked) {
				const options = [...group.suggestions.slice(0, 4), TYPE_OWN, KEEP_ORIGINAL];
				let choice = await ctx.ui.select(`"${group.word}"${times(group.occurrences.length)}`, options);
				if (choice === TYPE_OWN) {
					choice = (await ctx.ui.input(`Replace "${group.word}" with:`, group.word))?.trim();
				}
				if (choice && choice !== KEEP_ORIGINAL && choice !== group.word) {
					fixes.push(...expandFix(group, choice, group.suggestions.includes(choice)));
				}
			}
			const repSlots = Math.max(0, MAX_ASK - asked.length);
			const repGroups = groupRepetitions(reps);
			beyond += Math.max(0, repGroups.length - repSlots);
			for (const group of repGroups.slice(0, repSlots)) {
				const question = `Repeated word ${repetitionGroupLabel(group)}`;
				if ((await ctx.ui.select(question, [USE_ONCE, KEEP_ORIGINAL])) === USE_ONCE) {
					fixes.push(...group.runs.map(repetitionFix));
				}
			}
			if (beyond > 0) {
				ctx.ui.notify(`Spell check: ${beyond} more issues beyond the first ${MAX_ASK}`, "warning");
			}
			if (fixes.length === 0) return undefined;
			ctx.ui.notify(`Spell check: ${summarizeFixes(fixes)}`, "info");
			return applyFixes(text, fixes);
		}

		if (config.mode === "fix" || config.mode === "ask") {
			// Fix mode (or ask mode without UI / mid-stream): apply confident fixes.
			// Repeated words are safe to collapse outright (see VALID_REPEAT_WORDS).
			const fixes = [...confidentFixes(issues), ...reps.map(repetitionFix)];
			const unresolved = unresolvedIssues(issues, fixes);
			if (fixes.length > 0) {
				ctx.ui.notify(`Autocorrected ${fixes.length}: ${summarizeFixes(fixes)}`, "info");
			}
			if (unresolved.length > 0) {
				ctx.ui.notify(`Possible spelling, not autocorrected (${countIssues(unresolved)}): ${summarizeIssues(unresolved)}`, "warning");
			}
			return fixes.length > 0 ? applyFixes(text, fixes) : undefined;
		}

		// Warn mode.
		if (issues.length > 0) {
			ctx.ui.notify(`Possible spelling (${countIssues(issues)}): ${summarizeIssues(issues)}`, "warning");
		}
		if (reps.length > 0) {
			ctx.ui.notify(repeatedWordsNotice(reps), "warning");
		}
		return undefined;
	};

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (config.mode === "off") return { action: "continue" };
		const text = event.text;
		// Skip slash-commands and bash passthroughs.
		if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };

		const corrected = await processText(text, ctx);
		if (corrected === undefined || corrected === text) return { action: "continue" };
		return { action: "transform", text: corrected, images: event.images };
	});

	// --- commands ------------------------------------------------------------

	pi.registerCommand("spell", {
		description: "Spell-check the prompt draft in the editor",
		handler: async (_args, ctx) => {
			const text = ctx.ui.getEditorText();
			if (!text.trim()) {
				ctx.ui.notify("Editor is empty — nothing to check.", "info");
				return;
			}
			const { issues, reps } = analyze(text);
			if (issues.length === 0 && reps.length === 0) {
				ctx.ui.notify("Spell check: no issues found.", "info");
				return;
			}
			if (issues.length > 0) {
				ctx.ui.notify(`Spell check (${countIssues(issues)}): ${summarizeIssues(issues)}`, "warning");
			}
			if (reps.length > 0) {
				ctx.ui.notify(repeatedWordsNotice(reps), "warning");
			}

			const fixes = [...confidentFixes(issues), ...reps.map(repetitionFix)];
			if (fixes.length > 0 && (await ctx.ui.confirm("Apply corrections?", summarizeFixes(fixes)))) {
				ctx.ui.setEditorText(applyFixes(text, fixes));
			}
		},
	});

	pi.registerCommand("spell-mode", {
		description: "Show or change the autocorrect mode (off | warn | fix | ask)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg && MODES.includes(arg as Mode)) {
				config.mode = arg as Mode;
			} else if (ctx.hasUI) {
				const choice = await ctx.ui.select("Autocorrect mode", [
					"off — disabled",
					"warn — show mistakes (default)",
					"fix — auto-apply confident corrections",
					"ask — confirm each correction",
				]);
				if (!choice) return;
				config.mode = choice.split(" ")[0] as Mode;
			}
			saveConfig();
			setStatus(ctx.ui);
			ctx.ui.notify(`Autocorrect mode: ${config.mode}`, "info");
		},
	});

	const mutateUserWords = (args: string, add: boolean): string => {
		const words = args
			.toLowerCase()
			.split(/\s+/)
			.map((w) => w.replace(/[^'’\p{L}\p{N}-]/gu, ""))
			.filter((w) => w.length >= 2);
		if (words.length === 0) return "Usage: /spell-add <word…> or /spell-remove <word…>";
		for (const w of words) {
			if (add && !config.userWords.includes(w)) config.userWords.push(w);
			if (!add) config.userWords = config.userWords.filter((x) => x !== w);
		}
		saveConfig();
		dictionary = undefined; // rebuild on next use
		return `${add ? "Added" : "Removed"}: ${words.join(", ")}`;
	};

	pi.registerCommand("spell-add", {
		description: "Add words to your personal dictionary",
		handler: async (args, ctx) => ctx.ui.notify(mutateUserWords(args, true), "info"),
	});

	pi.registerCommand("spell-remove", {
		description: "Remove words from your personal dictionary",
		handler: async (args, ctx) => ctx.ui.notify(mutateUserWords(args, false), "info"),
	});
}
