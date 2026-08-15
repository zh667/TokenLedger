/**
 * Tests for the plugin's wiring, as opposed to its pure parts.
 *
 * Every bug a real DSH install has found in this package lived here — a service
 * sampled once at mount that was not ready yet, a fingerprint written onto an
 * object the next sweep rebuilds — and none of them was caught, because `apply`
 * had no test. Its collaborators are all reachable through the context or the
 * config, so a fake context is enough; nothing here touches a network or a disk.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/plugin.js";

const DAY = Date.parse("2026-08-15T10:00:00");

/** One assistant turn billed to `route`. */
const turn = (seq, route) => ({
	type: "assistant/message",
	seq,
	time: DAY,
	data: {
		turn: seq,
		step: 1,
		message: { role: "assistant", source: { kind: "model", provider: route, model: "gpt" } },
		usage: { inputTokens: 1000, outputTokens: 100 }
	}
});

/**
 * A context with just enough of Cordis to run `apply`.
 *
 * `settingsReadyAfter` reproduces the real failure: the service exists, but not
 * at mount time.
 */
function fakeContext(options = {}) {
	const { providers = [], section = {}, events = [], settings = undefined, settingsReadyAfter = 0 } = options;
	const disposers = [];
	let ticks = 0;

	const llm = { listConfigurableProviders: () => providers };
	const settingsService = settings ?? { get: () => section };

	const ctx = {
		logger: () => ({ info() {}, warn() {}, error() {} }),
		get(name) {
			if (name === "llm") return llm;
			if (name === "settings") return ticks >= settingsReadyAfter ? settingsService : undefined;
			return undefined;
		},
		inject(deps, callback) {
			// Cordis waits indefinitely for the service. The fake waits a bounded
			// number of turns instead: a real never-arriving service is a valid
			// scenario here, and an unbounded retry would starve the event loop
			// rather than let that test finish.
			let attempts = 0;
			const start = () => {
				const service = ctx.get(deps[0]);
				if (service !== undefined) return void callback({ ...ctx, [deps[0]]: service, on: () => {} });
				if (attempts++ < 10) setTimeout(start, 0);
			};
			start();
		},
		effect(fn) {
			const it = fn();
			if (typeof it?.next === "function") it.next();
		},
		on(event, handler) {
			if (event === "dispose") disposers.push(handler);
		},
		reflect: { provide() {} },
		sessionPersistence: {
			listSnapshots: async () => [{ header: { id: "s1" }, revision: `r${ticks}` }],
			readFrom: async (_id, from) => ({ events: from === 0 ? events : [] })
		}
	};

	return { ctx, tick: () => ticks++, dispose: () => disposers.forEach((d) => d()) };
}

const piAi = (route) => ({
	provider: route,
	displayName: route,
	settingsNs: "llm-pi-ai",
	settingsPath: ["providers", route]
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a relay is discovered and its traffic attributed, with no configuration at all", async () => {
	const { ctx } = fakeContext({
		providers: [piAi("api99")],
		section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } },
		events: [turn(1, "api99")]
	});
	let api;
	ctx.reflect.provide = (_name, value) => void (api = value);

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, detect: async () => ({ billingAvailable: false }) });
	await settle();

	assert.deepEqual(
		api.sites().map((s) => s.id),
		["api.relay-one.example"]
	);
	assert.equal(api.bySite({}).find((r) => r.site === "api.relay-one.example")?.tokens, 1100);
});

test("a fingerprint answer survives the next sweep", async () => {
	// The regression a real install showed as a site permanently reading 未识别.
	const { ctx, tick } = fakeContext({
		providers: [piAi("api99")],
		section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } }
	});
	let api;
	ctx.reflect.provide = (_name, value) => void (api = value);

	let asks = 0;
	apply(ctx, {
		database: ":memory:",
		sweepIntervalMs: 0,
		detect: async () => {
			asks++;
			return { billingAvailable: true, software: "newapi", confidence: 1 };
		}
	});
	await settle();
	assert.equal(api.sites()[0].type, "newapi");

	tick();
	await api.sweep();
	await settle();
	assert.equal(api.sites()[0].type, "newapi", "the rebuilt directory dropped what detection had learned");
	assert.equal(asks, 1, "and it must not re-interrogate the relay on every sweep");
});

test("a settings service that mounts after this plugin is still used", async () => {
	// The other real-install regression: `ctx.get('settings')` was sampled once
	// inside apply, before the service existed, so configuration could never be
	// saved even though discovery — which asks later — worked fine.
	const registered = [];
	const { ctx, tick } = fakeContext({
		providers: [piAi("api99")],
		section: { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } },
		settingsReadyAfter: 1,
		settings: {
			get: () => ({ providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } }),
			register: (ns) => {
				registered.push(ns);
				return { get: () => ({}), watch() {}, update: async () => {} };
			}
		}
	});

	let api;
	ctx.reflect.provide = (_name, value) => void (api = value);

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0, detect: async () => ({ billingAvailable: false }) });
	assert.deepEqual(registered, [], "nothing to register against yet");
	await settle();
	assert.deepEqual(api.sites(), [], "the startup sweep genuinely cannot see relays yet");

	tick(); // the settings service mounts, after this plugin already did
	// Let the waiting fiber notice it and the dynamic import resolve.
	for (let i = 0; i < 8; i++) await settle();

	assert.deepEqual(registered, ["tokenledger"], "the namespace was never registered");
	// Discovery reads provider profiles through that same service, so arriving
	// late must re-run it. Leaving it to the next timer tick showed a real
	// install "no relays" while its own report listed one.
	assert.deepEqual(
		api.sites().map((s) => s.id),
		["api.relay-one.example"],
		"the directory was left empty until the next sweep"
	);
});

test("a store that cannot be opened does not stop DSH from booting", () => {
	const { ctx } = fakeContext({});
	assert.doesNotThrow(() => apply(ctx, { database: "/nonexistent-dir/x/y.sqlite", sweepIntervalMs: 0 }));
});

test("no llm and no settings still collects, attributing everything to direct", async () => {
	const { ctx } = fakeContext({ events: [turn(1, "whatever")] });
	ctx.get = () => undefined;
	let api;
	ctx.reflect.provide = (_name, value) => void (api = value);

	apply(ctx, { database: ":memory:", sweepIntervalMs: 0 });
	await settle();

	assert.deepEqual(api.sites(), []);
	assert.equal(api.totals({}).outputTokens, 100, "usage accounting does not depend on knowing the site");
});
