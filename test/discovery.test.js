import assert from "node:assert/strict";
import test from "node:test";

import { discoverFromContext, discoverSites, mergeSites, readAtPath, withKnownSoftware } from "../src/discovery.js";
import { describeProbe, normalizeRelayConfig, runCommand } from "../src/plugin.js";
import { LedgerStore } from "../src/store.js";
import { applyUsageDelta } from "../src/usage.js";

/** The directory shape `dsh-llm-pi-ai` actually answers, verified against its source. */
const piAi = (route, declared) => ({
	provider: route,
	displayName: route,
	settingsNs: "llm-pi-ai",
	settingsPath: ["providers", route],
	declared
});

const section = (providers) => ({ providers });

test("a relay is read out of the host's provider configuration, not out of our config", () => {
	const { sites, providerBaseUrls } = discoverSites({
		providers: [piAi("myrelay", true)],
		readSection: () => section({ myrelay: { baseURL: "https://api.relay-one.example/v1" } })
	});
	assert.equal(sites.length, 1);
	assert.equal(sites[0].id, "api.relay-one.example");
	assert.equal(sites[0].discovered, true);
	assert.deepEqual(sites[0].routes, ["myrelay"]);
	assert.deepEqual(providerBaseUrls, { myrelay: "https://api.relay-one.example/v1" });
});

test("one key per model group is still one site, not two invoices", () => {
	const { sites } = discoverSites({
		providers: [piAi("gpt-route", true), piAi("claude-route", true)],
		readSection: () =>
			section({
				"gpt-route": { baseURL: "https://api.relay-one.example/v1" },
				"claude-route": { baseURL: "https://api.relay-one.example/v2" }
			})
	});
	assert.equal(sites.length, 1);
	assert.deepEqual(sites[0].routes.sort(), ["claude-route", "gpt-route"]);
});

test("the origin decides, not the `declared` flag", () => {
	// A SHIPPED route whose baseURL was overridden to a relay reports
	// declared:false while serving a relay. Keying on the flag would miss it.
	const { sites } = discoverSites({
		providers: [piAi("deepseek-official", false)],
		readSection: () => section({ "deepseek-official": { baseURL: "https://api.relay-one.example/v1" } })
	});
	assert.equal(sites.length, 1);
	assert.equal(sites[0].id, "api.relay-one.example");
	assert.equal(sites[0].declared, false, "the label is honest even though the site is real");
});

test("a site is only labelled user-declared when every route reaching it is", () => {
	const { sites } = discoverSites({
		providers: [piAi("a", true), piAi("b", false)],
		readSection: () =>
			section({ a: { baseURL: "https://relay.example/v1" }, b: { baseURL: "https://relay.example/v1" } })
	});
	assert.equal(sites.length, 1);
	assert.equal(sites[0].declared, false);
});

test("the credential sitting beside the base URL is never read", () => {
	const secret = "sk-must-never-appear-anywhere";
	const result = discoverSites({
		providers: [piAi("myrelay", true)],
		readSection: () =>
			section({
				myrelay: {
					baseURL: "https://api.relay-one.example/v1",
					apiKey: secret,
					apiKeyEnv: "RELAY_KEY",
					headers: { Authorization: `Bearer ${secret}` }
				}
			})
	});
	const serialized = JSON.stringify(result);
	assert.equal(serialized.includes(secret), false, "a secret reached the discovery result");
	assert.equal(serialized.includes("apiKeyEnv"), false, "even the credential reference is not copied");
	assert.equal(serialized.includes("Authorization"), false);
	assert.deepEqual(Object.keys(result.sites[0]).sort(), ["baseUrl", "declared", "discovered", "id", "routes"]);
});

test("a route with no configured endpoint is direct traffic, and is counted rather than shrugged at", () => {
	const { sites, skipped } = discoverSites({
		providers: [piAi("deepseek-official", false), piAi("relay", true)],
		readSection: () => section({ relay: { baseURL: "https://relay.example/v1" } })
	});
	assert.equal(sites.length, 1);
	assert.equal(skipped, 1, "a missing relay must have a number behind it");
});

test("an unparseable base URL is skipped, not turned into a site named after garbage", () => {
	const { sites, skipped } = discoverSites({
		providers: [piAi("a", true), piAi("b", true)],
		readSection: () => section({ a: { baseURL: "not a url" }, b: { baseURL: "ftp://x.example" } })
	});
	assert.deepEqual(sites, []);
	assert.equal(skipped, 2);
});

test("an official origin is traffic, not a relay site", () => {
	const { sites, providerBaseUrls } = discoverSites({
		providers: [piAi("official", false)],
		readSection: () => section({ official: { baseURL: "https://api.deepseek.com/v1" } }),
		officialOrigins: ["https://api.deepseek.com"]
	});
	assert.deepEqual(sites, []);
	assert.deepEqual(providerBaseUrls, { official: "https://api.deepseek.com/v1" }, "still mapped, just not a site");
});

test("one read per namespace, however many routes share it", () => {
	let reads = 0;
	discoverSites({
		providers: [piAi("a", true), piAi("b", true), piAi("c", true)],
		readSection: () => {
			reads++;
			return section({ a: { baseURL: "https://x.example" } });
		}
	});
	assert.equal(reads, 1);
});

test("a namespace that throws costs its routes, not the pass", () => {
	const { sites } = discoverSites({
		providers: [
			{ provider: "bad", settingsNs: "boom", settingsPath: ["providers", "bad"] },
			piAi("good", true)
		],
		readSection: (ns) => {
			if (ns === "boom") throw new Error("not exposed");
			return section({ good: { baseURL: "https://good.example/v1" } });
		}
	});
	assert.equal(sites.length, 1);
	assert.equal(sites[0].id, "good.example");
});

test("readAtPath stops at the first hop that is not a plain object", () => {
	assert.equal(readAtPath({ a: { b: 1 } }, ["a", "b"]), 1);
	assert.equal(readAtPath({ a: 1 }, ["a", "b"]), undefined);
	assert.equal(readAtPath({ a: [1] }, ["a", "0"]), undefined, "an array is not a settings object");
	assert.equal(readAtPath(undefined, ["a"]), undefined);
	assert.deepEqual(readAtPath({ a: 1 }, []), { a: 1 }, "an empty path means the whole section");
});

// --- reaching the host ------------------------------------------------------

test("a host with no llm or no settings answers 'cannot be asked', not 'no relays'", () => {
	// The distinction matters: one is a fact about the user's setup, the other is
	// a fact about ours, and only the second should ever be apologised for.
	assert.equal(discoverFromContext({ get: () => undefined }).available, false);
	assert.equal(discoverFromContext({}).available, false);
	assert.equal(
		discoverFromContext({ get: (n) => (n === "llm" ? { listConfigurableProviders: () => [] } : undefined) }).available,
		false
	);
});

test("a real-shaped context is walked end to end", () => {
	const ctx = {
		get: (name) =>
			name === "llm"
				? { listConfigurableProviders: () => [piAi("myrelay", true)] }
				: name === "settings"
					? { get: () => section({ myrelay: { baseURL: "https://api.relay-one.example/v1" } }) }
					: undefined
	};
	const result = discoverFromContext(ctx);
	assert.equal(result.available, true);
	assert.equal(result.sites[0].id, "api.relay-one.example");
});

test("an llm service that throws degrades instead of taking the plugin down", () => {
	const ctx = {
		get: (name) =>
			name === "llm"
				? {
						listConfigurableProviders() {
							throw new Error("rc bump");
						}
					}
				: { get: () => ({}) }
	};
	assert.deepEqual(discoverFromContext(ctx), { sites: [], providerBaseUrls: {}, skipped: 0, available: false });
});

// --- merging ----------------------------------------------------------------

test("a hand-written site overrides the discovered one, because it is the correction", () => {
	const discovered = discoverSites({
		providers: [piAi("r", true)],
		readSection: () => section({ r: { baseURL: "https://api.relay-one.example/v1" } })
	});
	const manual = normalizeRelayConfig({ relays: { r: { baseUrl: "https://api.relay-one.example/v1", id: "my-label" } } });
	const merged = mergeSites(discovered, manual);
	assert.equal(merged.sites.length, 2, "different ids are different sites; the label was the point");
	const labelled = merged.sites.find((s) => s.id === "my-label");
	assert.equal(labelled.discovered, false);
});

test("merging keeps the discovered route map and lets manual entries win per route", () => {
	const merged = mergeSites(
		{ sites: [], providerBaseUrls: { a: "https://one.example", b: "https://two.example" } },
		{ sites: [], providerBaseUrls: { b: "https://corrected.example" } }
	);
	assert.deepEqual(merged.providerBaseUrls, { a: "https://one.example", b: "https://corrected.example" });
});

test("merging nothing with nothing is not an error", () => {
	assert.deepEqual(mergeSites(), { sites: [], providerBaseUrls: {} });
});

test("a fingerprint result survives the directory being rebuilt", () => {
	// Regression, visible on a real install as a site permanently reading
	// 未识别: the detected type was written onto the site object, which every
	// sweep rebuilds from scratch, while the ask-once guard made sure detection
	// never ran again. The learned answers have to outlive the rebuild.
	const known = new Map([["api.relay-one.example", "newapi"]]);
	const rebuilt = [{ id: "api.relay-one.example", baseUrl: "https://api.relay-one.example" }];
	assert.equal(withKnownSoftware(rebuilt, known)[0].type, "newapi");
});

test("a hand-written type outranks the fingerprint, and an unknown site stays unknown", () => {
	const known = new Map([["a", "newapi"]]);
	const out = withKnownSoftware([{ id: "a", type: "sub2api" }, { id: "b" }], known);
	assert.equal(out[0].type, "sub2api", "the user overrode it on purpose");
	assert.equal(out[1].type, undefined, "absent is not the same as guessed");
});

test("withKnownSoftware does not mutate what it is given", () => {
	const original = [{ id: "a" }];
	withKnownSoftware(original, new Map([["a", "newapi"]]));
	assert.equal(original[0].type, undefined);
});

// --- reconciliation stays out of the way ------------------------------------

let seq = 0;
const relayTraffic = (at = Date.now()) => {
	const store = LedgerStore.open(":memory:");
	const state = store.loadState("s");
	applyUsageDelta(
		state,
		[
			{
				type: "assistant/message",
				seq: seq++,
				time: at,
				data: {
					turn: 1,
					step: 1,
					message: { role: "assistant", source: { kind: "model", provider: "api99", model: "gpt" } },
					usage: { inputTokens: 1000, outputTokens: 100 }
				}
			}
		],
		{ resolveSite: () => "api.relay-one.example" }
	);
	store.commitSession("s", state);
	return store;
};

test("a discovered relay with no billing reader is not decorated with a warning", async () => {
	// Sites used to be hand-written, so one without a reader meant a
	// half-finished setup. Now that they are discovered, that same warning would
	// fire on every relay of every install — a ⚠ about a feature nobody opted
	// into, which reads as "something is broken" when nothing is.
	const store = relayTraffic();
	try {
		const text = await runCommand("", { store, config: {}, sites: () => [{ id: "api.relay-one.example" }] });
		assert.ok(text.includes("api.relay-one.example"), "the site itself is still reported");
		assert.equal(text.includes("⚠"), false, `unasked-for warning: ${text}`);
		assert.equal(text.includes("账单读取器"), false);
	} finally {
		store.close();
	}
});

test("asking for reconcile explicitly still explains why it cannot", async () => {
	const store = relayTraffic();
	try {
		const text = await runCommand("reconcile", {
			store,
			config: {},
			sites: () => [{ id: "api.relay-one.example" }]
		});
		assert.ok(text.includes("账单读取器"), "the explanation belongs where it was asked for");
	} finally {
		store.close();
	}
});

test("configuring a billing reader brings the comparison back into the report", async () => {
	const store = relayTraffic();
	try {
		const text = await runCommand("", {
			store,
			config: { billing: { "api.relay-one.example": async () => null } },
			sites: () => [{ id: "api.relay-one.example" }]
		});
		assert.ok(text.includes("⚠"), "opting in means you want to hear about it");
	} finally {
		store.close();
	}
});

// --- the site subcommand ----------------------------------------------------

const emptyStore = () => LedgerStore.open(":memory:");

test("`site` with nothing discovered explains that direct is a normal answer", async () => {
	const store = emptyStore();
	try {
		const text = await runCommand("site", { store, config: {}, sites: () => [] });
		assert.ok(text.includes("没有发现任何中转站"));
		assert.ok(text.includes("直连"), "an empty list is not a broken install");
		assert.ok(text.includes("site add"));
	} finally {
		store.close();
	}
});

test("`site list` re-asks the host rather than trusting the last sweep's answer", async () => {
	// Regression: the listing read whatever the background sweep last produced.
	// The sweep at startup can run before the settings service that discovery
	// reads through, so the command reported "no relays" on an install whose
	// own report — drawn from the rollups — was listing one.
	const store = emptyStore();
	let refreshed = 0;
	let found = [];
	try {
		const text = await runCommand("site", {
			store,
			config: {},
			refresh: () => {
				refreshed++;
				found = [{ id: "api.relay-one.example", routes: ["api99"], discovered: true }];
			},
			sites: () => found
		});
		assert.equal(refreshed, 1);
		assert.ok(text.includes("api.relay-one.example"), "listed a stale, empty directory");
	} finally {
		store.close();
	}
});

test("`site list` distinguishes discovered from hand-written, and lists every route", async () => {
	const store = emptyStore();
	try {
		const text = await runCommand("site list", {
			store,
			config: {},
			sites: () => [
				{ id: "api.relay-one.example", routes: ["gpt", "claude"], type: "newapi", discovered: true },
				{ id: "my-label", routes: ["x"], type: undefined, discovered: false }
			]
		});
		assert.ok(text.includes("自动发现"));
		assert.ok(text.includes("手动"));
		assert.ok(text.includes("newapi"));
		assert.ok(text.includes("gpt, claude"));
	} finally {
		store.close();
	}
});

test("the ways a site can lack a type read differently", () => {
	// They used to print one word, so the only way to tell "still probing" from
	// "the probe could not be made" from "no known program matches" was to open
	// the DSH log — which is exactly what a user should not have to do to read
	// their own report.
	assert.equal(describeProbe({ type: "newapi" }, undefined), "newapi");
	assert.equal(describeProbe({}, { state: "pending" }), "探测中…");
	assert.ok(describeProbe({}, { state: "failed", reason: "fetch failed" }).includes("fetch failed"));
	assert.ok(describeProbe({}, { state: "unrecognized", reason: "没匹配上" }).includes("没匹配上"));
});

test("a site nobody probed says nothing about software at all", () => {
	// Fingerprinting is off by default — it only picks a billing adapter, and
	// billing is deferred. A placeholder here appeared on every site of every
	// install and read as a failure of something nobody had asked for.
	assert.equal(describeProbe({}, undefined), undefined);
});

test("the listing omits the software badge entirely when nothing determined it", async () => {
	const store = emptyStore();
	try {
		const text = await runCommand("site", {
			store,
			config: {},
			sites: () => [{ id: "api.relay-one.example", routes: ["api99"], discovered: true }],
			probeStatus: () => new Map()
		});
		assert.ok(text.includes("〔自动发现〕"), `badge should carry provenance alone: ${text}`);
		assert.equal(text.includes("未识别"), false);
		assert.equal(text.includes("未探测"), false);
	} finally {
		store.close();
	}
});

test("`site list` waits briefly so a first run reports a real answer", async () => {
	// The listing renders synchronously after refreshing, so before this the very
	// first run after a restart always said "unidentified" — not because
	// detection had failed but because it had not finished.
	const store = emptyStore();
	let type;
	try {
		const text = await runCommand("site", {
			store,
			config: {},
			refresh: () => {},
			settle: async () => void (type = "newapi"),
			sites: () => [{ id: "api.relay-one.example", routes: ["r"], type, discovered: true }],
			probeStatus: () => new Map()
		});
		assert.ok(text.includes("newapi"), `rendered before detection settled: ${text}`);
	} finally {
		store.close();
	}
});

test("a hand-written relay lists the route it was written against", () => {
	const { sites } = normalizeRelayConfig({ relays: { test: "https://api.example.com/v1" } });
	assert.deepEqual(sites[0].routes, ["test"], "a site with no routes at all reads as broken");
});

test("several hand-written routes on one relay collapse to one site listing both", () => {
	const { sites } = normalizeRelayConfig({
		relays: { a: "https://relay.example/v1", b: "https://relay.example/v2" }
	});
	assert.equal(sites.length, 1);
	assert.deepEqual(sites[0].routes, ["a", "b"]);
});

test("`site add` persists through the settings scope and never touches a file itself", async () => {
	const store = emptyStore();
	const saved = [];
	try {
		const text = await runCommand("site add myrelay https://api.relay-one.example/v1", {
			store,
			config: { relays: { existing: "https://other.example" } },
			sites: () => [],
			saveRelays: async (relays) => void saved.push(relays)
		});
		assert.ok(text.includes("api.relay-one.example"));
		assert.deepEqual(saved, [
			{ existing: "https://other.example", "myrelay": "https://api.relay-one.example/v1" }
		]);
	} finally {
		store.close();
	}
});

test("`site add` refuses a non-URL rather than storing a site named after it", async () => {
	const store = emptyStore();
	let saves = 0;
	try {
		const text = await runCommand("site add r notaurl", {
			store,
			config: {},
			sites: () => [],
			saveRelays: async () => void saves++
		});
		assert.ok(text.includes("不是一个可用的"));
		assert.equal(saves, 0);
	} finally {
		store.close();
	}
});

test("`site add` without both arguments prints usage instead of guessing", async () => {
	const store = emptyStore();
	try {
		const text = await runCommand("site add https://relay.example", {
			store,
			config: {},
			sites: () => [],
			saveRelays: async () => {}
		});
		assert.ok(text.includes("用法"));
	} finally {
		store.close();
	}
});

test("`site rm` deletes through the unset path, not by re-saving a shrunken map", async () => {
	// The bug a real install showed: rm reported success and the relay stayed in
	// the listing. `update()` DEEP-MERGES its patch, so handing it a map with the
	// key left out is not a deletion — it is a no-op that looks like one.
	// Upstream's removal path is `mutate` with an `unset` op, which names the key
	// to drop instead of a shape to merge.
	const store = emptyStore();
	const saved = [];
	const removed = [];
	const deps = {
		store,
		config: { relays: { manual: "https://a.example" } },
		sites: () => [],
		saveRelays: async (relays) => void saved.push(relays),
		removeRelay: async (route) => void removed.push(route)
	};
	try {
		assert.ok((await runCommand("site rm manual", deps)).includes("已删除"));
		assert.deepEqual(removed, ["manual"]);
		assert.deepEqual(saved, [], "the merging path must not be used for a deletion");

		const text = await runCommand("site rm discovered-one", deps);
		assert.ok(text.includes("自动发现的站点删不掉"));
		assert.ok(text.includes("provider"), "it must say where the real change belongs");
		assert.deepEqual(removed, ["manual"], "a refused removal writes nothing");
	} finally {
		store.close();
	}
});

test("`site rm` says so rather than claiming success when it cannot delete", async () => {
	const store = emptyStore();
	try {
		const text = await runCommand("site rm manual", {
			store,
			config: { relays: { manual: "https://a.example" } },
			sites: () => [],
			saveRelays: async () => {}
		});
		assert.equal(text.includes("已删除"), false, "reporting a deletion that did not happen is the whole bug");
		assert.ok(text.includes("settings.yaml"));
	} finally {
		store.close();
	}
});

test("a not-yet-ready settings service is not reported as a missing one", async () => {
	// Regression, found on a real Windows install: `settings` was sampled once
	// inside apply() and cached as undefined because the service mounts later,
	// so the plugin discovered relays THROUGH that service while telling the
	// user it did not exist. The two states now read differently, and only a
	// genuine registration failure names a file to go edit.
	const store = emptyStore();
	try {
		const pending = await runCommand("site add r https://relay.example", { store, config: {}, sites: () => [] });
		assert.ok(pending.includes("还没就绪"));
		assert.ok(pending.includes("重试"), "waiting is the fix for a race, not editing a file");

		const failed = await runCommand("site add r https://relay.example", {
			store,
			config: {},
			sites: () => [],
			saveUnavailableBecause: "Cannot find package '@deepseek-ai/schemastery'"
		});
		assert.ok(failed.includes("schemastery"), "a real failure must surface its reason");
		assert.ok(failed.includes("cordis.patch.yml"), "and only then name the path that still works");
		assert.equal(failed.includes("还没就绪"), false);
	} finally {
		store.close();
	}
});

// --- the surfaces that existed but nothing could reach ----------------------

test("diagnostics is reachable from the command, and names unattributed rows", async () => {
	// The store had it and the README claimed it shipped, but no command reached
	// it — the same overclaim as reconciliation, found by listing what a user can
	// actually type.
	const store = relayTraffic();
	try {
		const text = await runCommand("diagnostics", { store, config: {} });
		assert.ok(text.includes("索引诊断"));
		assert.ok(text.includes("汇总行数"));
		assert.ok(text.includes("归因不上的行"), "the one number that says the fold missed something");
	} finally {
		store.close();
	}
});

test("export defaults to json and takes csv on request", async () => {
	const store = relayTraffic();
	try {
		const json = await runCommand("export", { store, config: {} });
		const parsed = JSON.parse(json);
		assert.ok(Array.isArray(parsed.rows));
		assert.equal(parsed.rows[0].site, "api.relay-one.example");

		const csv = await runCommand("export csv", { store, config: {} });
		assert.ok(csv.split("\n")[0].startsWith("day,site,provider,model"));
		assert.ok(csv.includes("api.relay-one.example"));
	} finally {
		store.close();
	}
});

test("export accepts a day range and a site filter like the report does", async () => {
	const store = relayTraffic();
	try {
		const filtered = JSON.parse(await runCommand("export json 30 nowhere", { store, config: {} }));
		assert.deepEqual(filtered.rows, [], "a filter matching nothing must not export another site's rows");
		assert.equal(filtered.site, "nowhere");
	} finally {
		store.close();
	}
});

test("export sweeps first, so it cannot write figures a sweep would have improved", async () => {
	const store = relayTraffic();
	let swept = 0;
	try {
		await runCommand("export", { store, config: {}, sweep: async () => void swept++ });
		assert.equal(swept, 1);
	} finally {
		store.close();
	}
});

test("an unrecognized word is not silently reinterpreted as a site filter", async () => {
	// It used to be: `/tokenledger export` on a build without that subcommand
	// rendered a confident, empty report headed "site: export". A typo did the
	// same. Both look like a finding about your usage rather than a mistake in
	// what was typed.
	const store = relayTraffic();
	try {
		// A typo, and equally a subcommand from a newer version than is installed.
		const text = await runCommand("diagnostcs", { store, config: {} });
		assert.ok(text.includes("不认识"));
		assert.ok(text.includes("api.relay-one.example"), "say which site names would have worked");
		assert.ok(text.includes("diagnostics"), "and which subcommands exist");
		assert.equal(text.includes("没有记录到任何用量"), false, "an empty report is the wrong answer here");
	} finally {
		store.close();
	}
});

test("a real site idle during the range still gets the empty-range message", async () => {
	// The check is against all time on purpose: a site that exists but was idle
	// this week is a genuine empty range, not a typo, and the two need different
	// answers.
	const store = relayTraffic(Date.now() - 200 * 86_400_000);
	try {
		const text = await runCommand("2 api.relay-one.example", { store, config: {} });
		assert.equal(text.includes("不认识"), false);
		assert.ok(text.includes("没有记录到任何用量"));
	} finally {
		store.close();
	}
});

test("a non-default port is part of the site's identity", async () => {
	// Two self-hosted relays on one machine differ only by port. Dropping it
	// made them a single site whose rows were the sum of both — found by running
	// two stub relays on 127.0.0.1.
	const { sites } = discoverSites({
		providers: [piAi("a", true), piAi("b", true)],
		readSection: () =>
			section({ a: { baseURL: "http://127.0.0.1:7801/v1" }, b: { baseURL: "http://127.0.0.1:7802/v1" } })
	});
	assert.equal(sites.length, 2);
	assert.deepEqual(sites.map((s) => s.id).sort(), ["127.0.0.1:7801", "127.0.0.1:7802"]);
});

test("a default port is still dropped, so ordinary sites stay readable", async () => {
	const { sites } = discoverSites({
		providers: [piAi("a", true)],
		readSection: () => section({ a: { baseURL: "https://relay.example:443/v1" } })
	});
	assert.deepEqual(sites.map((s) => s.id), ["relay.example"]);
});
