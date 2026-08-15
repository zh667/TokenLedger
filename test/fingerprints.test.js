/**
 * The fingerprint registry.
 *
 * These are the tests that could not be written while this lived inside
 * `apply()`: every one of them drives the state machine directly, with a stub
 * `detect`, and none of them mounts a plugin or touches the network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createFingerprintRegistry } from "../src/fingerprints.js";

const site = (id, baseUrl = `https://${id}.example`) => ({ id, baseUrl });
const found = (software, confidence = "high") => async () => ({ billingAvailable: true, software, confidence });

test("disabled means no probe at all, not a probe whose answer is dropped", async () => {
	let calls = 0;
	const reg = createFingerprintRegistry({ detect: async () => void calls++, enabled: false });
	reg.request(site("a"));
	await reg.settle();
	assert.equal(calls, 0);
	assert.equal(reg.status().size, 0, "a site nobody asked about has no probe state either");
});

test("a site is asked once, however many sweeps go past", async () => {
	let calls = 0;
	const reg = createFingerprintRegistry({
		enabled: true,
		detect: async () => {
			calls++;
			return { billingAvailable: true, software: "newapi", confidence: "high" };
		}
	});
	reg.request(site("a"));
	await reg.settle();
	reg.request(site("a"));
	reg.request(site("a"));
	await reg.settle();
	assert.equal(calls, 1);
});

test("an unrecognized site is not asked again either", async () => {
	// The guard has to be keyed on "was asked", not on "has an answer" — an
	// unrecognized relay has no answer to show, and re-probing it on every sweep
	// is a request to a third party that can never succeed.
	let calls = 0;
	const reg = createFingerprintRegistry({
		enabled: true,
		detect: async () => {
			calls++;
			return { billingAvailable: false, reason: "no signature matched" };
		}
	});
	reg.request(site("a"));
	await reg.settle();
	reg.request(site("a"));
	await reg.settle();
	assert.equal(calls, 1);
	assert.equal(reg.status().get("a").state, "unrecognized");
});

test("a site that already declares its type is never probed", async () => {
	let calls = 0;
	const reg = createFingerprintRegistry({ enabled: true, detect: async () => void calls++ });
	reg.request({ id: "a", baseUrl: "https://a.example", type: "newapi" });
	await reg.settle();
	assert.equal(calls, 0);
});

test("pending, identified, unrecognized and failed are four different answers", async () => {
	// Collapsing them into one "unidentified" is what sent people to the DSH log
	// to find out whether a probe was still running or had never worked.
	const reg = createFingerprintRegistry({ enabled: true, detect: found("newapi") });
	reg.request(site("ok"));
	assert.equal(reg.status().get("ok").state, "pending", "state exists before the answer does");
	await reg.settle();
	assert.deepEqual(reg.status().get("ok"), { state: "identified", confidence: "high" });

	const nope = createFingerprintRegistry({
		enabled: true,
		detect: async () => ({ billingAvailable: false, reason: "nothing matched" })
	});
	nope.request(site("x"));
	await nope.settle();
	assert.deepEqual(nope.status().get("x"), { state: "unrecognized", reason: "nothing matched" });

	const broke = createFingerprintRegistry({
		enabled: true,
		detect: async () => {
			throw new Error("ECONNREFUSED");
		}
	});
	broke.request(site("y"));
	await broke.settle();
	assert.deepEqual(broke.status().get("y"), { state: "failed", reason: "ECONNREFUSED" });
});

test("an ambiguous match names the candidates instead of saying nothing matched", async () => {
	const reg = createFingerprintRegistry({
		enabled: true,
		detect: async () => ({ billingAvailable: false, ambiguous: ["newapi", "oneapi"] })
	});
	reg.request(site("a"));
	await reg.settle();
	assert.match(reg.status().get("a").reason, /newapi、oneapi/);
});

test("learning notifies, so a derived view cannot go stale until the next sweep", async () => {
	// The original bug: the answer went into the map and nowhere else, so the
	// site directory kept saying "unidentified" for up to a whole sweep interval
	// after detection had already succeeded.
	const seen = [];
	const reg = createFingerprintRegistry({ enabled: true, detect: found("sub2api"), onLearn: (m) => seen.push(new Map(m)) });
	reg.request(site("a"));
	await reg.settle();
	assert.equal(seen.length, 1);
	assert.equal(seen[0].get("a"), "sub2api");
	assert.equal(reg.software.get("a"), "sub2api");
});

test("a failed probe learns nothing and notifies nobody", async () => {
	let notified = 0;
	const reg = createFingerprintRegistry({
		enabled: true,
		onLearn: () => notified++,
		detect: async () => {
			throw new Error("nope");
		}
	});
	reg.request(site("a"));
	await reg.settle();
	assert.equal(notified, 0);
	assert.equal(reg.software.size, 0);
});

test("settle is bounded, so one unreachable relay cannot hold a command open", async () => {
	let release;
	const reg = createFingerprintRegistry({ enabled: true, detect: () => new Promise((resolve) => (release = resolve)) });
	reg.request(site("hangs"));

	// settle's own timer is unref'd on purpose — a pending probe must not keep
	// DSH's event loop alive — so the test supplies something that does.
	const keepAlive = setTimeout(() => {}, 5_000);
	await reg.settle(10); // resolves on the timer, not on the probe
	clearTimeout(keepAlive);

	assert.equal(reg.status().get("hangs").state, "pending", "settle returning is not the probe finishing");
	release({ billingAvailable: false, reason: "arrived late" });
	await reg.settle();
	assert.equal(reg.status().get("hangs").state, "unrecognized", "and the late answer still lands");
});

test("settle with nothing in flight resolves without waiting", async () => {
	const reg = createFingerprintRegistry({ enabled: true, detect: found("newapi") });
	await reg.settle(60_000); // would hang for a minute if it waited on the timer
});

test("status hands out a snapshot, not the live map", async () => {
	const reg = createFingerprintRegistry({ enabled: true, detect: found("newapi") });
	reg.request(site("a"));
	const before = reg.status();
	await reg.settle();
	assert.equal(before.get("a").state, "pending", "an earlier snapshot must not change under the caller");
	assert.equal(reg.status().get("a").state, "identified");
});
