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

test("providing workspace changes nothing about whether it boots", async () => {
	const { ctx, fiber } = await boot(plugin, { sessionPersistence: persistence, workspace: { resolveByPath: async () => undefined } });
	try {
		assert.equal(fiber.state, ACTIVE);
	} finally {
		await ctx.fiber?.dispose?.();
	}
});
