/**
 * Tests for the ask-mode wiring in index.ts: one prompt per distinct word,
 * applied to every occurrence, and always offering "keep original" first.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// index.ts resolves its config path at import time, so HOME must point at a
// temp profile (mode "ask") before the module is loaded.
const home = mkdtempSync(join(tmpdir(), "pi-autocorrect-"));
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "pi-autocorrect.json"), JSON.stringify({ mode: "ask", userWords: [] }));
process.env.HOME = home;

const { default: autocorrect } = await import("../index.ts");

const KEEP = "keep original";
const TYPE_OWN = "type a correction…";

/** Choose the offered correction (or "use it once"), never the safe option. */
const accept = (_q, options) => options.find((o) => o !== KEEP && o !== TYPE_OWN);
/** Choose the safe option. */
const keep = () => KEEP;

/**
 * Load the extension with a fake UI and send `text` as a user prompt.
 * `choose(question, options)` returns the option to pick for each prompt.
 * Returns { text, prompts, notices }.
 */
function runAsk(text, choose) {
	const handlers = {};
	autocorrect({ on: (name, fn) => (handlers[name] = fn), registerCommand: () => {} });
	handlers.session_start({}, { ui: { setStatus() {} } });

	const prompts = [];
	const notices = [];
	const ctx = {
		hasUI: true,
		ui: {
			setStatus() {},
			notify: (msg) => notices.push(msg),
			select: async (question, options) => {
				prompts.push(question);
				return choose(question, options);
			},
			input: async (_q, preset) => preset,
		},
	};
	return handlers.input({ text, source: "user", images: [] }, ctx).then((res) => ({
		text: res.action === "transform" ? res.text : text,
		prompts,
		notices,
	}));
}

test("ask mode prompts once per distinct word and fixes every occurrence", async () => {
	const input = "I recieve the message, then recieve it again. Also seperate the seperate files.";
	const { text, prompts } = await runAsk(input, accept);
	assert.deepEqual(prompts, ['"recieve" ×2', '"seperate" ×2']);
	assert.equal(text, "I receive the message, then receive it again. Also separate the separate files.");
});

test("keeping a word leaves every occurrence untouched", async () => {
	const input = "recieve and recieve again";
	const { text, prompts } = await runAsk(input, keep);
	assert.equal(prompts.length, 1);
	assert.equal(text, input);
});

test("keep original is offered first, so nothing is rewritten by accident", async () => {
	const input = "I saw the the cat with a recieve";
	const offered = [];
	const { text } = await runAsk(input, (_q, options) => {
		offered.push(options);
		return KEEP;
	});
	assert.equal(offered.length, 2);
	assert.deepEqual(offered.map((options) => options[0]), [KEEP, KEEP]);
	assert.equal(offered[0][1], "receive"); // the correction comes second
	assert.equal(offered[1][1], "use it once");
	assert.equal(text, input);
});

test("a single occurrence is not annotated with a count", async () => {
	const { prompts } = await runAsk("one recieve here", accept);
	assert.deepEqual(prompts, ['"recieve"']);
});

test("ask mode offers to collapse a repeated word", async () => {
	const { text, prompts } = await runAsk("I saw the the the cat", accept);
	assert.deepEqual(prompts, ['Repeated word "the" ×3']);
	assert.equal(text, "I saw the cat");
});

test("keeping a repeated word leaves the run in place", async () => {
	const input = "I saw the the cat";
	const { text, prompts } = await runAsk(input, keep);
	assert.equal(prompts.length, 1);
	assert.equal(text, input);
});

test("several runs of the same repeated word get a single question", async () => {
	const { text, prompts } = await runAsk("give the the cat the the milk", accept);
	assert.deepEqual(prompts, ['Repeated word "the" ×4 in 2 places']);
	assert.equal(text, "give the cat the milk");
});

test("a misspelled repeat goes to the spelling pass, not the collapse", async () => {
	const { text, prompts } = await runAsk("recieve recieve it", accept);
	assert.deepEqual(prompts, ['"recieve" ×2']);
	assert.equal(text, "receive receive it");
});
