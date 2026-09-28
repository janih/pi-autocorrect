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
import type { Fix, Issue } from "./lib/spellcheck.ts";
import { applyFixes, checkText, confidentFixes, unresolvedIssues } from "./lib/spellcheck.ts";

// ---------------------------------------------------------------------------
// Configuration (persisted in ~/.pi/agent/pi-autocorrect.json)
// ---------------------------------------------------------------------------

type Mode = "off" | "warn" | "fix" | "ask";
const MODES: Mode[] = ["off", "warn", "fix", "ask"];
const DEFAULT_MODE: Mode = "warn";
const TYPE_OWN = "type a correction…";
const KEEP_ORIGINAL = "keep original";
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

/** One-line summary of issues: "recieve → receive, xyzzy (no suggestion)" */
function summarizeIssues(issues: Issue[]): string {
	const parts = issues.slice(0, MAX_REPORT).map((i) => (i.suggestions.length > 0 ? `${i.word} → ${i.suggestions[0]}` : `${i.word} (?)`));
	if (issues.length > MAX_REPORT) parts.push(`+${issues.length - MAX_REPORT} more`);
	return parts.join(", ");
}

function summarizeFixes(fixes: Fix[]): string {
	const parts = fixes.slice(0, MAX_REPORT).map((f) => `${f.original} → ${f.replacement}`);
	if (fixes.length > MAX_REPORT) parts.push(`+${fixes.length - MAX_REPORT} more`);
	return parts.join(", ");
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

	/** Warn / fix / ask handling for one input text. Returns transformed text or undefined. */
	const processText = async (text: string, ctx: Pick<ExtensionContext, "hasUI" | "ui">): Promise<string | undefined> => {
		const dict = ensureDictionary();
		const issues = checkText(text, dict);
		if (issues.length === 0) return undefined;

		const interactive = ctx.hasUI && config.mode === "ask";

		if (interactive) {
			// Ask mode: confirm each correction, keep anything the user declines.
			const fixes: Fix[] = [];
			const MAX_ASK = 8;
			for (const issue of issues.slice(0, MAX_ASK)) {
				const options = [...issue.suggestions.slice(0, 4), TYPE_OWN, KEEP_ORIGINAL];
				let choice = await ctx.ui.select(`"${issue.word}"`, options);
				if (choice === TYPE_OWN) {
					choice = (await ctx.ui.input(`Replace "${issue.word}" with:`, issue.word))?.trim();
				}
				if (choice && choice !== KEEP_ORIGINAL && choice !== issue.word) {
					fixes.push({ start: issue.start, end: issue.end, original: issue.word, replacement: choice });
				}
			}
			if (issues.length > MAX_ASK) {
				ctx.ui.notify(`Spell check: ${issues.length - MAX_ASK} more issues beyond the first ${MAX_ASK}`, "warning");
			}
			if (fixes.length === 0) return undefined;
			ctx.ui.notify(`Spell check: ${summarizeFixes(fixes)}`, "info");
			return applyFixes(text, fixes);
		}

		if (config.mode === "fix" || config.mode === "ask") {
			// Fix mode (or ask mode without UI / mid-stream): apply confident fixes.
			const fixes = confidentFixes(issues);
			const unresolved = unresolvedIssues(issues, fixes);
			if (fixes.length > 0) {
				ctx.ui.notify(`Autocorrected ${fixes.length}: ${summarizeFixes(fixes)}`, "info");
			}
			if (unresolved.length > 0) {
				ctx.ui.notify(`Possible spelling, not autocorrected (${unresolved.length}): ${summarizeIssues(unresolved)}`, "warning");
			}
			return fixes.length > 0 ? applyFixes(text, fixes) : undefined;
		}

		// Warn mode.
		ctx.ui.notify(`Possible spelling (${issues.length}): ${summarizeIssues(issues)}`, "warning");
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
			const dict = ensureDictionary();
			const issues = checkText(text, dict);
			if (issues.length === 0) {
				ctx.ui.notify("Spell check: no issues found.", "info");
				return;
			}
			ctx.ui.notify(`Spell check (${issues.length}): ${summarizeIssues(issues)}`, "warning");

			const fixes = confidentFixes(issues);
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
