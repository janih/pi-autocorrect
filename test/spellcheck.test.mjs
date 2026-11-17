/**
 * Tests for the spellcheck engine. Run: npm test
 * (Node >= 22.6 type stripping, no transpilation needed.)
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Dictionary, loadDictionary } from "../lib/dictionary.ts";
import {
	applyFixes,
	checkText,
	confidentFixes,
	editDistance,
	expandFix,
	findRepetitions,
	groupIssues,
	groupRepetitions,
	repetitionFix,
	repetitionLabel,
	repetitionGroupLabel,
	suggest,
	tokenize,
	unresolvedIssues,
} from "../lib/spellcheck.ts";

const dict = loadDictionary();

test("dictionary loads with expected sources", () => {
	assert.ok(dict.size > 80_000, `dict too small: ${dict.size}`);
	assert.equal(dict.has("colour"), true);
	assert.equal(dict.has("git"), true, "tech word git missing");
	assert.equal(dict.has("kubernetes"), true, "tech word kubernetes missing");
	assert.equal(dict.has("npm"), true);
});

test("edit distance basics", () => {
	assert.equal(editDistance("the", "the", 2), 0);
	assert.equal(editDistance("teh", "the", 1), 1, "transposition at tight cutoff");
	assert.equal(editDistance("teh", "the", 2), 1, "transposition");
	assert.equal(editDistance("recieve", "receive", 2), 1, "transposition ie<->ei");
	assert.equal(editDistance("abc", "xyz", 2), 3);
	assert.equal(editDistance("adn", "and", 1), 1, "transposition");
});

test("simple misspellings are flagged with suggestions", () => {
	const issues = checkText("I recieve the message yesterday", dict);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].word, "recieve");
	assert.ok(issues[0].suggestions.includes("receive"), `got ${issues[0].suggestions}`);
});

test("teh is suggested as the", () => {
	const s = suggest("teh", dict);
	assert.equal(s[0], "the");
});

test("correct prose produces no issues", () => {
	const text = "Could you refactor the configuration handling in the editor widget please?";
	assert.deepEqual(checkText(text, dict), []);
});

test("tech vocabulary is accepted in prose", () => {
	const text = "Commit the gitignore change, run the linter, then deploy to kubernetes via npm scripts.";
	assert.deepEqual(checkText(text, dict).map((i) => i.word), []);
});

test("code spans, fences, urls, paths and emails are protected", () => {
	const text = [
		"Use `recievec` verbatim.", // inline code
		"```",
		"const recieve = notawordd;",
		"```",
		"See https://example.com/recievec?q=zzz and mail me at recievec@example.com.",
		"The file is at /usr/local/recievec/bin.",
	].join("\n");
	assert.deepEqual(checkText(text, dict), []);
});

test("identifiers are not checked", () => {
	for (const w of ["notAwordd", "XMLParserd", "SOMEREALLYLONGTHING", "snake_cased", "recievec.json", "--recievec"]) {
		assert.deepEqual(checkText(`see ${w} now`, dict), [], `should skip ${w}`);
	}
});

test("possessives use the base word", () => {
	assert.deepEqual(checkText("the user's terminal", dict), []);
	const issues = checkText("the userz's terminal", dict);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].word, "userz's");
	assert.ok(issues[0].suggestions.includes("users's") || issues[0].suggestions.includes("user's"));
});

test("hyphenated words check each part", () => {
	assert.deepEqual(checkText("a well-known state-of-the-art reciever", dict).map((i) => i.word), ["reciever"]);
});

test("suggestions preserve initial capitalisation", () => {
	assert.equal(suggest("Recieve", dict)[0], "Receive");
});

test("confident fixes work and stay conservative", () => {
	const fixes = confidentFixes(checkText("Teh build recieve failed becuase of a typo", dict));
	const applied = applyFixes("Teh build recieve failed becuase of a typo", fixes);
	assert.equal(applied, "The build receive failed because of a typo");
});

test("ambiguous short words are not auto-fixed", () => {
	// "adn" has several distance-1 candidates; only priored "and" should win.
	const fixes = confidentFixes(checkText("cat adn dog", dict));
	assert.deepEqual(applyFixes("cat adn dog", fixes), "cat and dog");
	// A word with no close candidate gets no fix.
	const fixes2 = confidentFixes(checkText("xkqvwj thing", dict));
	assert.equal(fixes2.length, 0);
});

test("multiple fixes apply at correct offsets", () => {
	const text = "teh recieve amd teh send";
	const fixes = confidentFixes(checkText(text, dict));
	assert.equal(applyFixes(text, fixes), "the receive amd the send");
});

test("unresolvedIssues reports only issues without a confident fix", () => {
	// "recieved" has an equally close rival ("relieved") so it stays unresolved;
	// "seperate" is confidently fixed. Only "recieved" may be reported.
	const text = "I recieved the seperate file yesterday";
	const issues = checkText(text, dict);
	const fixes = confidentFixes(issues);
	const unresolved = unresolvedIssues(issues, fixes);
	assert.deepEqual(unresolved.map((i) => i.word), ["recieved"]);
	assert.equal(unresolved.length, issues.length - fixes.length);
	// All-fixed text reports nothing unresolved.
	const issues2 = checkText("teh definately wrong", dict);
	assert.deepEqual(unresolvedIssues(issues2, confidentFixes(issues2)), []);
});

test("tokenizer marks prose tokens as checkable", () => {
	const tokens = tokenize("Hello world `code` skip");
	assert.equal(tokens.filter((t) => t.check).map((t) => t.text).join(" "), "Hello world skip");
});

test("empty and trivial input", () => {
	assert.deepEqual(checkText("", dict), []);
	assert.deepEqual(checkText("ok :)", dict), []);
});

test("user words extend the dictionary", () => {
	const d2 = new Dictionary();
	d2.addWords(["flurble"]);
	assert.equal(d2.has("FLURBLE"), true);
});

test("repeated words collapse into one group, in order of first appearance", () => {
	const issues = checkText("recieve then recieve again, then separte", dict);
	assert.equal(issues.length, 3);
	const groups = groupIssues(issues);
	assert.deepEqual(
		groups.map((g) => [g.word, g.occurrences.length]),
		[
			["recieve", 2],
			["separte", 1],
		],
	);
});

test("grouping ignores case but keeps each occurrence's exact text", () => {
	const groups = groupIssues(checkText("Recieve here and recieve there", dict));
	assert.equal(groups.length, 1);
	assert.deepEqual(groups[0].occurrences.map((o) => o.word), ["Recieve", "recieve"]);
});

test("possessive forms are not merged with the plain word", () => {
	const groups = groupIssues(checkText("the userz and userz's terminal", dict));
	assert.deepEqual(groups.map((g) => g.word), ["userz", "userz's"]);
});

test("expandFix applies one decision to every occurrence, matching case", () => {
	const text = "Recieve it, then recieve it again";
	const group = groupIssues(checkText(text, dict))[0];
	const fixes = expandFix(group, "Receive");
	assert.equal(fixes.length, 2);
	assert.equal(applyFixes(text, fixes), "Receive it, then receive it again");
});

test("expandFix keeps hand-typed replacements verbatim", () => {
	const text = "recieve it, then Recieve it again";
	const group = groupIssues(checkText(text, dict))[0];
	// fromSuggestions=false: the user typed this, so don't re-case it per occurrence.
	assert.equal(applyFixes(text, expandFix(group, "Receive", false)), "Receive it, then Receive it again");
	// A choice taken from the suggestion list is re-cased per occurrence.
	assert.equal(applyFixes(text, expandFix(group, "receive")), "receive it, then Receive it again");
});

test("repeated adjacent words collapse to one copy", () => {
	const text = "I saw the the the cat and and a dog";
	const reps = findRepetitions(text);
	assert.deepEqual(
		reps.map((r) => [r.word, r.count]),
		[
			["the", 3],
			["and", 2],
		],
	);
	assert.equal(applyFixes(text, reps.map(repetitionFix)), "I saw the cat and a dog");
});

test("repetition matching ignores case but keeps the first word's casing", () => {
	const text = "The the book";
	const reps = findRepetitions(text);
	assert.equal(reps.length, 1);
	assert.equal(applyFixes(text, reps.map(repetitionFix)), "The book");
});

test("short repeated words are caught even though they are not spell-checked", () => {
	assert.equal(findRepetitions("give it an an hour").length, 1);
});

test("valid same-word sequences and non-adjacent repeats are left alone", () => {
	for (const text of [
		"I had had enough of that",
		"that that is true",
		"this is very very good",
		"yes, yes I know", // punctuation between
		"the other the same",
		"wrapped lines the\nthe keep it",
		"run `the the` in your shell", // code span
	]) {
		assert.deepEqual(findRepetitions(text), [], `should skip: ${text}`);
	}
	// Same words inside a fenced block are protected too.
	assert.deepEqual(findRepetitions("```\nthe the\n```"), []);
});

test("findRepetitions skips the words you hand it", () => {
	assert.equal(findRepetitions("tha tha tha").length, 1);
	assert.equal(findRepetitions("tha tha tha", new Set(["tha"])).length, 0);
});

test("repetitionLabel reads well for pairs and longer runs", () => {
	assert.equal(repetitionLabel({ word: "the", start: 0, end: 7, count: 2 }), "the the");
	assert.equal(repetitionLabel({ word: "the", start: 0, end: 13, count: 4 }), "the ×4");
});

test("repeated runs of the same word are grouped into one question", () => {
	const groups = groupRepetitions(findRepetitions("the the cat and and the the dog and the"));
	assert.deepEqual(
		groups.map((g) => [repetitionGroupLabel(g), g.runs.length]),
		[
			['"the" ×4 in 2 places', 2],
			['"and" ×2', 1],
		],
	);
	// One decision collapses every run of that word.
	const text = "the the cat and and the the dog and the";
	const collapsed = applyFixes(text, groups[0].runs.map(repetitionFix));
	assert.equal(collapsed, "the cat and and the dog and the");
});

test("applyFixes drops a fix that would overlap an accepted one", () => {
	const text = "the the cat";
	const collapsed = applyFixes(text, [
		{ start: 0, end: 7, original: "the the", replacement: "the" },
		{ start: 4, end: 7, original: "the", replacement: "cat" },
	]);
	assert.equal(collapsed, "the cat");
});
