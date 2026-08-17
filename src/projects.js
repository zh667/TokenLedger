/**
 * Naming the directories a session ran in.
 *
 * ## Why the key is the directory and not a workspace id
 *
 * DSH has a workspace registry, and at a glance it is exactly the thing to
 * group by. Its semantics say otherwise. `ctx.workspace.create(path, title?)`
 * canonicalizes through `fs.realpath` and creates **at most one record per
 * canonical path**, and membership is decided by strict equality —
 * `sessionIds` keeps only ids whose indexed path `=== record.path`.
 *
 * So a workspace is not a container that holds projects. It is a directory,
 * plus a display name, plus the sessions that started in exactly that
 * directory. One workspace is one project, by construction.
 *
 * Keying on its id would lose two kinds of usage, and lose them silently:
 *
 * - a session started one level down (`cd src && dsh`) has a cwd equal to no
 *   workspace path, so it belongs to none — the host calls this Ungrouped;
 * - a project the user never registered in the GUI does not exist at all.
 *
 * Both are likely to be the majority. A per-project view that quietly covers
 * only "registered, and started at the root" looks complete and is not, and the
 * person reading it has no way to tell.
 *
 * This is the rule relay attribution already follows: sites group by the origin
 * normalized out of `baseURL`, never by the route alias, because a route called
 * `deepseek` may point anywhere. **The cwd is what happened; the workspace
 * title is what someone typed.** Group by the fact, name with the label.
 *
 * ## Why naming is split in two
 *
 * `resolveByPath` is async — it applies the registry's own `realpath` canon —
 * and the panel payload is assembled synchronously in one pass. So the lookup
 * happens once per sweep, per distinct directory, and the payload composes
 * display rows from the cached titles. A directory with no cached title still
 * renders, under its own name; a slow or missing registry costs a nicer label
 * and never a row.
 *
 * @module dsh-tokenledger/projects
 */

/**
 * What the workspace registry is called, newest name first.
 *
 * `@deepseek-ai/dsh-workspace@0.1.0-rc.6` provides `workspaceRegistry`; the
 * 0.0.1-rc.x line that npm's `latest` tag points at provides `workspace`. The
 * API is identical — `resolveByPath`, `list`, `get` — so only the name has to
 * be tolerated, and asking for only one of them meant project titles silently
 * never resolved and every row fell back to its directory name.
 */
const REGISTRY_NAMES = ["workspaceRegistry", "workspace"];

/**
 * The workspace registry this composition provides, under whichever name.
 *
 * @param ctx - the Cordis context.
 * @returns the service, or undefined — which is a supported state, not a fault.
 */
export function workspaceRegistry(ctx) {
	if (typeof ctx?.get !== "function") return undefined;
	for (const name of REGISTRY_NAMES) {
		try {
			const found = ctx.get(name);
			if (found !== undefined) return found;
		} catch {
			// A context that refuses an undeclared name simply has not got it.
		}
	}
	return undefined;
}

/** Last path segment, for either separator. */
export function basename(path) {
	const parts = String(path).split(/[\\/]+/).filter((segment) => segment !== "");
	return parts.at(-1) ?? String(path);
}

/**
 * How one project row is labelled.
 *
 * Synchronous, so the payload can be built in one pass.
 *
 * @param project - the stored directory. `''` means the header carried no cwd.
 * @param title - the workspace title for it, if one was found.
 */
export function describeProject(project, title) {
	// Not a failure to report — a session can legitimately have no cwd. It gets
	// its own row so the total stays whole and the gap is visible.
	if (typeof project !== "string" || project === "") return { project: "", unattributed: true };
	const named = typeof title === "string" && title.trim() !== "" ? title.trim() : undefined;
	return {
		project,
		label: named ?? basename(project),
		// The full path rides along regardless: two projects called `web` in
		// different trees are one ambiguous row otherwise.
		path: project,
		...(named === undefined ? {} : { titled: true })
	};
}

/**
 * Workspace titles for a set of directories.
 *
 * @param projects - the directories, as stored.
 * @param workspace - `ctx.get('workspace')`, or undefined. Optional on purpose:
 *   it supplies titles and nothing else, and a composition without it must
 *   still get the whole breakdown rather than losing the section.
 * @returns a Map from directory to title, holding only the ones that have one.
 */
export async function readProjectTitles(projects, workspace) {
	const titles = new Map();
	if (workspace?.resolveByPath === undefined) return titles;

	// One lookup per DISTINCT directory, not per session: a busy install has
	// thousands of sessions across a handful of directories.
	for (const project of new Set(projects)) {
		if (typeof project !== "string" || project === "") continue;
		try {
			// The raw cwd is handed over rather than pre-resolved, because
			// `resolveByPath` applies the registry's own canon and matching it by
			// hand would be a second, drifting copy of that rule.
			const found = await workspace.resolveByPath(project);
			const text = typeof found?.title === "string" ? found.title.trim() : "";
			if (text !== "") titles.set(project, text);
		} catch {
			// A directory that has been deleted or renamed rejects. The row keeps
			// its own name; nothing about the usage it holds is less true.
		}
	}
	return titles;
}
