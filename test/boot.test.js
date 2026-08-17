/**
 * Does the plugin actually activate.
 *
 * Every other test in this repository passed while `dsh web` refused to start.
 * They had to: the bug was a wrong `inject` shape, and the static assertion
 * guarding `inject` was written in the same commit, so it asserted whatever the
 * code happened to say. A test authored beside the code it checks cannot catch
 * a mistake in the author's model of the contract.
 *
 * So this one does not assert a shape. It boots the plugin against the real
 * Cordis, with the same service missing that a real composition might be
 * missing, and asks the only question that matters: did the fiber reach ACTIVE.
 *
 * `@deepseek-ai/cordis` is a devDependency for this. Nothing ships with it —
 * the package still installs with zero runtime dependencies, which
 * `packaging.test.js` enforces separately.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import * as plugin from "../src/plugin.js";

/** Cordis fiber states; 2 is ACTIVE and 0 is PENDING on a missing service. */
const ACTIVE = 2;

/** Enough of `sessionPersistence` for a sweep to run and find nothing. */
const persistence = { listSnapshots: async () => [], readFrom: async () => ({ events: [] }) };

/** Boot `subject` in a fresh context and return its fiber once it settles. */
async function boot(subject, provide = { sessionPersistence: persistence }) {
	const ctx = new Context();
	for (const [name, value] of Object.entries(provide)) ctx.reflect.provide(name, value);
	const fiber = ctx.plugin(subject, { database: ":memory:", sweepIntervalMs: 0, sweepOnStart: false });
	await fiber.await?.();
	// A nested `ctx.inject` is a CHILD fiber, and awaiting the parent does not
	// await it. The routes attach on that child, so a check that skips this
	// settles too early and reports an empty route table for a healthy plugin.
	await new Promise((resolve) => setTimeout(resolve, 50));
	return { ctx, fiber };
}

test("the plugin activates with only the service it declares", async () => {
	// `workspace` is deliberately absent. It supplies project display names and
	// nothing else, so a composition without it must still boot — and this
	// Cordis has no optional dependency, so the only way to depend on it
	// weakly is not to declare it.
	const { ctx, fiber } = await boot(plugin);
	try {
		assert.equal(fiber.state, ACTIVE, `fiber is in state ${fiber.state}, not ACTIVE — it is waiting for a service`);
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

test("a required/optional inject object would NOT activate, which is why it is banned", async () => {
	// The shape that shipped and took the host down. Kept as an executable
	// record of what Cordis does with it: `Inject.resolve` reads an object as a
	// `name -> intercept config` map, so this asks for two services literally
	// named `required` and `optional`.
	//
	// This is also what proves the test above can fail. A boot check that
	// passes for both shapes would be checking nothing.
	const broken = { name: plugin.name, apply: plugin.apply, inject: { required: ["sessionPersistence"], optional: ["workspace"] } };
	const { ctx, fiber } = await boot(broken);
	try {
		assert.notEqual(fiber.state, ACTIVE, "if this ever activates, Cordis changed and the rule above can be revisited");
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

test("the plugin does not activate when its one real dependency is missing", async () => {
	// The other half of the same question: `sessionPersistence` is genuinely
	// required, and declaring it has to mean something.
	const { ctx, fiber } = await boot(plugin, {});
	try {
		assert.notEqual(fiber.state, ACTIVE);
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

// --- the routes actually attach ------------------------------------------------

/** A stand-in for the host's HTTP server that records what gets registered. */
function httpServerStub() {
	const routes = [];
	return { routes, register: (spec) => (routes.push(spec), () => {}), registerUpgrade: () => () => {}, registerFallback: () => () => {} };
}

test("the panel's routes register against the service the host actually provides", async () => {
	// The service is `httpServer`. The PACKAGE is `dsh-host-webserver`, and the
	// name that shipped was `webServer` — so the nested inject waited forever,
	// the routes never existed, and the panel 404'd while every log line said
	// the plugin had loaded.
	//
	// Nothing static could have caught it. `http.test.js` asserted the waited-for
	// name and passed, because it asserted whatever the source said. Only asking
	// "did a route appear on the real service" is a question the author's own
	// wrong assumption cannot answer for itself.
	const httpServer = httpServerStub();
	const { ctx, fiber } = await boot(plugin, { sessionPersistence: persistence, httpServer });
	try {
		assert.equal(fiber.state, ACTIVE);
		const paths = httpServer.routes.map((route) => route.path).sort();
		assert.deepEqual(paths, ["/api/tokenledger/balance", "/api/tokenledger/usage"]);
		for (const route of httpServer.routes) {
			assert.equal(route.kind, "exact", "an exact route wins over the RPC prefix; a prefix route would not");
			assert.equal(typeof route.handler, "function");
		}
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

test("the usage route answers a real request end to end", async () => {
	// Registration is only half of it. `apply()` wraps route setup in a catch so
	// a broken panel never takes the harness down — which also meant a
	// ReferenceError in our own code (`detect`, left behind by a refactor)
	// became one grey warning while every request 404'd. Calling the handler is
	// the only way to find the next one of those.
	const httpServer = httpServerStub();
	const { ctx } = await boot(plugin, { sessionPersistence: persistence, httpServer });
	try {
		const usage = httpServer.routes.find((route) => route.path === "/api/tokenledger/usage");
		assert.ok(usage, "no usage route to call");

		let status;
		let body;
		await usage.handler(
			{ method: "GET", url: "/api/tokenledger/usage", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:3080" } },
			{ writeHead: (code) => void (status = code), end: (text) => void (body = JSON.parse(text)) }
		);

		assert.equal(status, 200, `handler answered ${status}: ${JSON.stringify(body)}`);
		assert.equal(body.ok, true);
		// The sections the panel renders. A payload missing one of these is a
		// blank card, and a blank card is indistinguishable from an empty account.
		for (const key of ["totals", "windows", "days", "models", "sites", "projects", "accounts", "diagnostics"]) {
			assert.ok(key in body, `payload has no ${key}`);
		}
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

test("a non-loopback caller is refused by the route, not served", async () => {
	// The fence lives in the handler, so it has to survive being reached through
	// a real registration rather than only through a direct unit call.
	const httpServer = httpServerStub();
	const { ctx } = await boot(plugin, { sessionPersistence: persistence, httpServer });
	try {
		const usage = httpServer.routes.find((route) => route.path === "/api/tokenledger/usage");
		let status;
		await usage.handler(
			{ method: "GET", url: "/api/tokenledger/usage", socket: { remoteAddress: "203.0.113.7" }, headers: { host: "127.0.0.1:3080" } },
			{ writeHead: (code) => void (status = code), end: () => {} }
		);
		assert.equal(status, 403);
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

test("either real name for the host's route registry works", async () => {
	// `dsh-host-webserver@0.1.0-rc.6` provides `webServer`; the 0.0.1-rc.x line
	// that npm's `latest` tag points at provides `httpServer`. Both are real,
	// and asking for only one of them is how this panel 404'd for a week — the
	// name was "verified" against a version the harness does not compose.
	for (const name of ["webServer", "httpServer"]) {
		const server = httpServerStub();
		const { ctx, fiber } = await boot(plugin, { sessionPersistence: persistence, [name]: server });
		try {
			assert.equal(fiber.state, ACTIVE, name);
			assert.deepEqual(
				server.routes.map((route) => route.path).sort(),
				["/api/tokenledger/balance", "/api/tokenledger/usage"],
				`no routes registered against ${name}`
			);
		} finally {
			await ctx.fiber?.dispose?.();
		}
	}
});

test("a name that is not one of them registers nothing, and still boots", async () => {
	// Proves the test above can fail, and records why nothing reported the
	// original bug: a nested inject fiber is not an entry, so DSH's activation
	// assertion never sees it hanging. The plugin looks perfectly healthy.
	const server = httpServerStub();
	const { ctx, fiber } = await boot(plugin, { sessionPersistence: persistence, someOtherServer: server });
	try {
		assert.equal(fiber.state, ACTIVE, "it boots perfectly happily, serving nothing");
		assert.deepEqual(server.routes, []);
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

test("only one registration happens when both names are present", async () => {
	// Two waits are outstanding. A composition providing both must not get the
	// routes twice — the host throws on a duplicate path.
	const webServer = httpServerStub();
	const httpServer = httpServerStub();
	const { ctx } = await boot(plugin, { sessionPersistence: persistence, webServer, httpServer });
	try {
		assert.equal(webServer.routes.length + httpServer.routes.length, 2, "registered twice, which the host rejects");
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

test("a headless composition still boots, just without the routes", async () => {
	// No HTTP server at all. Collecting usage must not depend on a browser.
	const { ctx, fiber } = await boot(plugin);
	try {
		assert.equal(fiber.state, ACTIVE);
	} finally {
		await ctx.fiber?.dispose?.();
	}
});

test("providing workspace changes nothing about whether it boots", async () => {
	const { ctx, fiber } = await boot(plugin, { sessionPersistence: persistence, workspace: { resolveByPath: async () => undefined } });
	try {
		assert.equal(fiber.state, ACTIVE);
	} finally {
		await ctx.fiber?.dispose?.();
	}
});
