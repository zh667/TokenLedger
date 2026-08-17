/**
 * Per-project attribution.
 *
 * The load-bearing decision is that the key is the directory a session ran in,
 * not a workspace id. Most of these tests exist to hold that line, because
 * keying on the workspace id is the obvious thing to do and it loses usage
 * silently — which is the one failure mode this project treats as unacceptable.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LedgerStore, normalizeProject } from "../src/store.js";
import { basename, describeProject, readProjectTitles, workspaceRegistry } from "../src/projects.js";
import { applyUsageDelta } from "../src/usage.js";

const DAY = "2026-08-17";

/** One message event carrying usage, at `day`. */
function message(seq, turn, model, tokens, day = DAY) {
	return {
		seq,
		time: Date.parse(`${day}T12:00:00Z`),
		type: "assistant/message",
		data: { turn, step: 1, provider: "deepseek", model, usage: { inputTokens: tokens, outputTokens: 0 } }
	};
}

/** Fold one session's usage into a fresh store, under `cwd`. */
function withUsage(sessions) {
	const store = LedgerStore.open(":memory:");
	for (const [sessionId, cwd, tokens] of sessions) {
		const state = store.loadState(sessionId);
		applyUsageDelta(state, [message(1, 1, "v4", tokens)]);
		store.commitSession(sessionId, state, { project: cwd });
	}
	return store;
}

// --- the key ---------------------------------------------------------------

test("sessions in one directory are one project", () => {
	const store = withUsage([
		["a", "/home/me/ledger", 100],
		["b", "/home/me/ledger", 50],
		["c", "/home/me/other", 7]
	]);
	try {
		assert.deepEqual(
			store.byProject().map((row) => [row.project, row.tokens]),
			[
				["/home/me/ledger", 150],
				["/home/me/other", 7]
			]
		);
	} finally {
		store.close();
	}
});

test("a session started in a subdirectory is its own project, not a lost one", () => {
	// The workspace registry decides membership by strict equality against the
	// registered path, so `cd src && dsh` belongs to no workspace at all — the
	// host calls it Ungrouped. Keyed on the cwd it is simply another row, and
	// the tokens stay in the total either way.
	const store = withUsage([
		["a", "/home/me/ledger", 100],
		["b", "/home/me/ledger/src", 40]
	]);
	try {
		const rows = store.byProject();
		assert.equal(rows.length, 2);
		assert.equal(
			rows.reduce((sum, row) => sum + row.tokens, 0),
			140,
			"whatever the grouping, the total must not move"
		);
	} finally {
		store.close();
	}
});

test("a project nobody registered as a workspace still appears", () => {
	// Keyed on a workspace id this row would not exist. There is no registry in
	// this test at all, and the breakdown is still complete.
	const store = withUsage([["a", "/tmp/scratch", 9]]);
	try {
		assert.deepEqual(store.byProject(), [
			{ ...store.byProject()[0], project: "/tmp/scratch" }
		]);
		assert.equal(store.byProject()[0].tokens, 9);
	} finally {
		store.close();
	}
});

test("a session with no cwd is counted, never dropped", () => {
	// The whole point of the empty-string row. Usage that leaves the totals
	// without a trace is worse than usage nobody can name: one is invisible, the
	// other is a row on the panel that says so.
	const store = withUsage([
		["a", "/home/me/ledger", 100],
		["b", undefined, 25]
	]);
	try {
		const rows = store.byProject();
		assert.equal(rows.length, 2);
		const orphan = rows.find((row) => row.project === "");
		assert.equal(orphan.tokens, 25);
		assert.equal(store.totals().tokens, 125, "the sum of the rows is the total");
	} finally {
		store.close();
	}
});

test("a rollup whose sessions row is missing is still counted", () => {
	// A LEFT JOIN rather than an inner one. An inner join drops the row, and the
	// per-project figures then quietly stop summing to the total the rest of the
	// panel shows — the exact failure this whole design is arranged against.
	const db = new DatabaseSync(":memory:");
	const store = new LedgerStore(db);
	try {
		const state = store.loadState("a");
		applyUsageDelta(state, [message(1, 1, "v4", 100)]);
		store.commitSession("a", state, { project: "/home/me/ledger" });
		db.exec("DELETE FROM sessions");

		const rows = store.byProject();
		assert.deepEqual(rows.map((row) => row.project), [""]);
		assert.equal(rows[0].tokens, 100, "the tokens survive losing their name");
		assert.equal(store.totals().tokens, 100);
	} finally {
		store.close();
	}
});

test("the project breakdown honours the site filter, like every other breakdown", () => {
	const store = LedgerStore.open(":memory:");
	try {
		const state = store.loadState("a");
		applyUsageDelta(
			state,
			[
				{
					seq: 1,
					time: Date.parse(`${DAY}T12:00:00Z`),
					type: "assistant/message",
					data: {
						turn: 1,
						step: 1,
						message: { role: "assistant", source: { kind: "model", provider: "api99", model: "v4" } },
						usage: { inputTokens: 100, outputTokens: 0 }
					}
				}
			],
			{ resolveSite: () => "relay.example" }
		);
		store.commitSession("a", state, { project: "/home/me/ledger" });
		assert.equal(store.byProject({}, "relay.example")[0].tokens, 100);
		assert.equal(store.byProject({}, "somewhere.else").length, 0);
	} finally {
		store.close();
	}
});

test("dropping a session forgets its project too", () => {
	const store = withUsage([["a", "/home/me/ledger", 100]]);
	try {
		store.dropSession("a");
		assert.deepEqual(store.byProject(), []);
	} finally {
		store.close();
	}
});

// --- the stored form -------------------------------------------------------

test("only a trailing separator is stripped", () => {
	// Resolving symlinks would be an fs call per session per sweep, against
	// directories that may since have been deleted — cost and a failure mode, to
	// merge spellings DSH records identically anyway.
	assert.equal(normalizeProject("/home/me/ledger/"), "/home/me/ledger");
	assert.equal(normalizeProject("/home/me/ledger"), "/home/me/ledger");
	assert.equal(normalizeProject("C:\\work\\ledger\\"), "C:\\work\\ledger");
	assert.equal(normalizeProject("  /home/me/ledger  "), "/home/me/ledger");
	assert.equal(normalizeProject("/"), "/", "the root is not stripped to nothing");
});

test("an absent cwd becomes the empty string, not null", () => {
	for (const absent of [undefined, null, "", "   ", 42, {}]) {
		assert.equal(normalizeProject(absent), "", JSON.stringify(absent));
	}
});

// --- naming ----------------------------------------------------------------

test("a project with no workspace is named by its directory", () => {
	assert.deepEqual(describeProject("/home/me/ledger", undefined), {
		project: "/home/me/ledger",
		label: "ledger",
		path: "/home/me/ledger"
	});
});

test("a registered workspace lends its title, and the path rides along", () => {
	// Two projects called `web` in different trees are one ambiguous row without
	// the path, so it is carried whether or not the label came from a title.
	const described = describeProject("/home/me/ledger", "  Token Ledger  ");
	assert.equal(described.label, "Token Ledger");
	assert.equal(described.path, "/home/me/ledger");
	assert.equal(described.titled, true);
});

test("a blank workspace title is not a name", () => {
	assert.equal(describeProject("/home/me/ledger", "   ").label, "ledger");
	assert.equal(describeProject("/home/me/ledger", "").titled, undefined);
});

test("the sessions with no directory get a row of their own, marked", () => {
	assert.deepEqual(describeProject("", undefined), { project: "", unattributed: true });
	assert.deepEqual(describeProject(undefined, "Ignored"), { project: "", unattributed: true });
});

test("basename handles both separators and a trailing one", () => {
	assert.equal(basename("/home/me/ledger"), "ledger");
	assert.equal(basename("C:\\work\\ledger"), "ledger");
	assert.equal(basename("/home/me/ledger/"), "ledger");
	assert.equal(basename("ledger"), "ledger");
});

test("the workspace registry is found under either name it has shipped as", async () => {
	// `dsh-workspace@0.1.0-rc.6` provides `workspaceRegistry`; the 0.0.1-rc.x
	// line npm's `latest` points at provides `workspace`. The API is identical,
	// so only the name has to be tolerated — and asking for only one meant
	// titles silently never resolved and every row fell back to its directory.
	for (const name of ["workspaceRegistry", "workspace"]) {
		const service = { resolveByPath: async () => ({ title: "Found" }) };
		const ctx = { get: (asked) => (asked === name ? service : undefined) };
		assert.equal(workspaceRegistry(ctx), service, name);
		assert.equal((await readProjectTitles(["/a"], workspaceRegistry(ctx))).get("/a"), "Found", name);
	}
});

test("the newer name wins when a composition somehow has both", async () => {
	const registry = { resolveByPath: async () => undefined };
	const legacy = { resolveByPath: async () => undefined };
	const ctx = { get: (asked) => (asked === "workspaceRegistry" ? registry : asked === "workspace" ? legacy : undefined) };
	assert.equal(workspaceRegistry(ctx), registry);
});

test("no registry under any name is undefined, not a throw", async () => {
	assert.equal(workspaceRegistry({ get: () => undefined }), undefined);
	assert.equal(workspaceRegistry({}), undefined);
	assert.equal(workspaceRegistry(undefined), undefined);
	// A context that refuses an undeclared name simply has not got it.
	assert.equal(workspaceRegistry({ get: () => { throw new Error("not injected"); } }), undefined);
});

test("titles are looked up once per directory, not once per session", async () => {
	// A busy install has thousands of sessions across a handful of directories.
	const asked = [];
	const workspace = {
		resolveByPath: async (path) => {
			asked.push(path);
			return { title: `WS ${basename(path)}` };
		}
	};
	const titles = await readProjectTitles(["/a", "/a", "/a", "/b"], workspace);
	assert.deepEqual(asked, ["/a", "/b"]);
	assert.equal(titles.get("/a"), "WS a");
});

test("a composition with no workspace service still names every project", async () => {
	// It supplies titles and nothing else. Requiring it would trade a whole
	// capability for a label.
	for (const workspace of [undefined, null, {}, { resolveByPath: undefined }]) {
		assert.equal((await readProjectTitles(["/a"], workspace)).size, 0);
	}
	assert.equal(describeProject("/a", undefined).label, "a", "and the fallback is a real name");
});

test("a directory the registry rejects costs the title, not the row", async () => {
	// It rejects for a deleted or renamed directory. Nothing about the usage
	// already recorded against that path is less true.
	const workspace = {
		resolveByPath: async (path) => {
			if (path === "/gone") throw new Error("ENOENT");
			return { title: "Here" };
		}
	};
	const titles = await readProjectTitles(["/gone", "/here"], workspace);
	assert.equal(titles.has("/gone"), false);
	assert.equal(titles.get("/here"), "Here");
});

test("the empty project is never looked up", async () => {
	// There is no path to resolve, and asking would be a rejection per sweep.
	const asked = [];
	await readProjectTitles(["", "/a"], { resolveByPath: async (p) => void asked.push(p) });
	assert.deepEqual(asked, ["/a"]);
});
