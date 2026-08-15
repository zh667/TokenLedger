/**
 * The package's own shape.
 *
 * These are the failures that produce no error anywhere: the browser half is
 * simply absent, the scanner's negative verdict is cached forever, and the only
 * symptom is a missing entry in a sidebar. A unit test is the only cheap place
 * to catch them.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");

/** The `name:` of every inserted loader entry. */
const entryNames = [...patch.matchAll(/^\s*name:\s*'?([^'\s#]+)'?\s*$/gm)].map((m) => m[1]);

test("every loader entry names the bare package, never a subpath", () => {
	// `dsh-client-modules` resolves `<entryName>/package.json` to decide whether
	// an entry is a client package. A subpath entry name fails that resolve, the
	// failure is swallowed as "not a client package", and the verdict is cached
	// and never expires — so the panel never loads and nothing reports why.
	assert.ok(entryNames.length > 0, "the patch must insert something");
	for (const name of entryNames) {
		assert.equal(name, pkg.name, `entry name ${name} must be the bare package name`);
		assert.equal(name.includes("/"), false, "a subpath entry name breaks the client-module scan");
	}
});

test("the resolve the scanner performs actually succeeds", () => {
	// Exactly `require.resolve(`${entryName}/package.json`)`, which is what the
	// scanner does. Self-referencing needs the `./package.json` export.
	const require = createRequire(import.meta.url);
	for (const name of entryNames) {
		assert.doesNotThrow(() => require.resolve(`${name}/package.json`), `${name}/package.json must resolve`);
	}
});

test("declaring dsh.client obliges the package to export ./client", () => {
	// The scanner throws on this mismatch rather than skipping the package.
	if (pkg.dsh?.client === undefined) return;
	assert.equal(pkg.dsh.client.platform, "web");
	assert.ok(pkg.exports["./client"], 'dsh.client without an "./client" export is a hard error upstream');
});

test("the package root is a valid Cordis plugin, because the entry name points at it", async () => {
	const root = await import("../src/index.js");
	assert.equal(typeof root.apply, "function", "a bare entry name loads the root export as the plugin");
	assert.ok(Array.isArray(root.inject));
	assert.equal(typeof root.name, "string");
});

test("every file the manifest points at is shipped", () => {
	// `files` decides what npm publishes; an export outside it resolves in the
	// repository and 404s from a tarball.
	const shipped = pkg.files;
	for (const target of Object.values(pkg.exports)) {
		if (typeof target !== "string" || target === "./package.json") continue;
		const top = target.replace(/^\.\//, "").split("/")[0];
		assert.ok(shipped.includes(top) || shipped.includes(target.replace(/^\.\//, "")), `${target} is not in files`);
	}
	assert.ok(shipped.includes(pkg.dsh.bundle.patch.replace(/^\.\//, "")), "the bundle patch must ship");
});

test("no official @deepseek-ai package is a hard dependency", () => {
	// The host already has these loaded; listing one under `dependencies` makes
	// npm install a second copy beside the host's, and a schema class from the
	// duplicate is not the class the host's `settings.register` expects. The
	// ecosystem indexes reject on this too. Our one use is a dynamic import
	// behind a handled failure, so `optional` is honest.
	for (const name of Object.keys(pkg.dependencies ?? {})) {
		assert.equal(name.startsWith("@deepseek-ai/"), false, `${name} must be a peer, not a dependency`);
	}
	for (const name of Object.keys(pkg.peerDependencies ?? {})) {
		assert.equal(
			pkg.peerDependenciesMeta?.[name]?.optional,
			true,
			`${name} is loaded through a dynamic import the caller recovers from, so it must be an optional peer`
		);
	}
});

test("every local image the README shows is shipped", () => {
	// README.md is in `files`, so npm renders it on the package page — but it
	// renders with the tarball's own contents. An image the repository has and
	// the tarball doesn't is a broken box on the listing, visible to everyone
	// except us.
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const refs = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)]
		.map((m) => m[1])
		.filter((src) => !/^(https?:)?\/\//.test(src));

	assert.ok(refs.length > 0, "the hero screenshot is the README's centrepiece");
	for (const src of refs) {
		assert.doesNotThrow(
			() => readFileSync(new URL(`../${src}`, import.meta.url)),
			`${src} is referenced but absent from the repository`
		);
		const covered = pkg.files.some((entry) => src === entry || src.startsWith(`${entry}/`));
		assert.ok(covered, `${src} is not under any entry in files`);
	}
});
