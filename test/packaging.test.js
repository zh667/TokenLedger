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
import { readdirSync, readFileSync } from "node:fs";
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

test("inject is a flat array of names, because an object means something else", async () => {
	// Cordis normalizes an object `inject` as a `name -> intercept config` map:
	//
	//   if (Array.isArray(inject)) for (const name of inject) result[name] = null;
	//   else for (const name of Object.keys(inject)) result[name] = inject[name] ?? null;
	//
	// So `{ required: [...], optional: [...] }` does not mean what it reads like.
	// It asks for two services named `required` and `optional`. Neither exists,
	// the plugin stays pending, and DSH's activation assertion fails the whole
	// boot — `dsh web` did not start at all. That shipped once.
	//
	// The test that should have caught it was widened in the same commit to
	// accept the object, which is worse than having no test: it reported the bug
	// as verified.
	const { inject } = await import("../src/plugin.js");
	assert.ok(Array.isArray(inject), "an object inject is a config map, not a required/optional split");
	for (const name of inject) assert.equal(typeof name, "string", `${String(name)} must be a bare service name`);
});

test("only services the plugin genuinely cannot start without are injected", async () => {
	// This Cordis has no optional dependency: every declared name is required,
	// and a missing one takes the host down rather than degrading a feature.
	// Anything the plugin can work without is read with `ctx.get(name)`, which
	// answers `undefined` instead of throwing — `workspace` is read that way,
	// so a per-project row falls back to its directory name and nothing breaks.
	const { inject } = await import("../src/plugin.js");
	assert.deepEqual(inject, ["sessionPersistence"]);
	assert.equal(inject.includes("workspace"), false, "titles are a nicety; requiring them would trade the panel for a label");

	const source = readFileSync(new URL("../src/plugin.js", import.meta.url), "utf8");
	assert.match(source, /workspaceRegistry\(ctx\)/, "and it has to actually be read through the tolerant door");
});

test("declaring dsh.client obliges the package to export ./client", () => {
	// The scanner throws on this mismatch rather than skipping the package.
	if (pkg.dsh?.client === undefined) return;
	assert.equal(pkg.dsh.client.platform, "web");
	assert.ok(pkg.exports["./client"], 'dsh.client without an "./client" export is a hard error upstream');
});

const root = await import("../src/index.js");

test("the package root is a valid Cordis plugin, because the entry name points at it", async () => {
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

test("no source file contains a raw control byte", () => {
	// This has now happened twice: a NUL written literally into a template
	// literal as a key separator, once in `adapters/newapi.js` and once in
	// `http.js`. Node parses it fine and every test passes, so nothing surfaces
	// it — but `file` reports the source as binary and **grep skips the whole
	// file**. Three hundred lines then become invisible to every repository-wide
	// search, including the credential scan run before each commit. `\u0000`
	// compiles to the same string and leaves the file text.
	const root = new URL("../src/", import.meta.url);
	const walk = (dir) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
			return entry.isDirectory() ? walk(child) : entry.name.endsWith(".js") ? [child] : [];
		});

	for (const file of walk(root)) {
		const bytes = readFileSync(file);
		const at = bytes.findIndex((b) => b < 0x09 || (b > 0x0d && b < 0x20));
		assert.equal(
			at,
			-1,
			`${file.pathname.split("/src/")[1]} holds a raw 0x${bytes[at]?.toString(16).padStart(2, "0")} byte at offset ${at}; write it as an escape so grep can still read the file`
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

test("the package root stays a promise, not an inventory", () => {
	// It re-exported 88 symbols, internals included, so every rename downstream
	// was a breaking change — which is what had blocked cleaning the modules up.
	// Anything not listed here is still reachable through its own subpath, where
	// the import itself says you are reaching for an internal.
	const promised = ["apply", "inject", "name", "foldUsage", "bySite", "byModel"].sort();
	const actual = Object.keys(root).sort();
	assert.deepEqual(actual, promised, "widening the root is a decision, so it has to be made here first");
});

test("every subpath in exports actually resolves", async () => {
	// Narrowing the root is only safe because the subpaths carry the rest.
	for (const [subpath, target] of Object.entries(pkg.exports)) {
		if (subpath === "./package.json" || subpath === "./client") continue; // client needs a browser
		const module = await import(new URL(`../${target.replace(/^\.\//, "")}`, import.meta.url));
		assert.ok(Object.keys(module).length > 0, `${subpath} resolves but exports nothing`);
	}
});
