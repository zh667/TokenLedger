/**
 * Disposable SQLite index over the authoritative DSH session logs.
 *
 * The DSH log is the fact. Everything here is a projection that can be thrown
 * away and rebuilt, and the code is arranged so that rebuilding is the normal
 * path rather than a recovery path — a rebuild you only run after a disaster is
 * a rebuild you find out is broken during one.
 *
 * The load-bearing choice is that rollups are stored **per session**, keyed
 * `(sessionId, day, site, provider, model)`, not as one globally accumulated
 * figure. Re-folding a session then means deleting its rows and writing the new
 * ones; global numbers come from `GROUP BY`. The alternative — a single global
 * counter that each session adds into — requires subtracting a session's old
 * contribution before re-adding it, and a single arithmetic slip there corrupts
 * the total permanently with no way to notice. Here, a wrong session's rows are
 * replaced wholesale by the next fold and the damage cannot spread.
 *
 * Fold state that is not expressible as rollup rows — the last usage sample and
 * the current route, both needed to keep replacement semantics exact across a
 * fold boundary — rides the checkpoint row as JSON. It is O(1) per session.
 *
 * Uses Node's built-in `node:sqlite`, so the package keeps zero runtime
 * dependencies. Node emits an ExperimentalWarning for it on v22; that is
 * upstream's warning to give, not ours to swallow.
 *
 * @module dsh-tokenledger/store
 */

import { DatabaseSync } from "node:sqlite";

import { createUsageState, totalTokens, cacheHitRate, parseRouteKey, routeKey, zeroBuckets } from "./usage.js";

export const SCHEMA_VERSION = 2;

const COLUMNS = [
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
	"requests"
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_rollups (
  sessionId        TEXT    NOT NULL,
  day              TEXT    NOT NULL,
  site             TEXT    NOT NULL,
  provider         TEXT    NOT NULL,
  model            TEXT    NOT NULL,
  inputTokens      INTEGER NOT NULL DEFAULT 0,
  outputTokens     INTEGER NOT NULL DEFAULT 0,
  cacheReadTokens  INTEGER NOT NULL DEFAULT 0,
  cacheWriteTokens INTEGER NOT NULL DEFAULT 0,
  reasoningTokens  INTEGER NOT NULL DEFAULT 0,
  requests         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sessionId, day, site, provider, model)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_rollups_day  ON session_rollups (day);
CREATE INDEX IF NOT EXISTS idx_rollups_site ON session_rollups (site, day);

-- Which directory a session ran in, which is what "project" means here.
--
-- Its own table rather than a column on session_rollups: the project is a
-- property of the SESSION, not of each (day, site, model) rollup row. As a
-- column it would store the same path dozens of times per session and widen a
-- primary key that is already five wide. Joined at query time instead.
--
-- The project column is the header's cwd with a trailing slash removed and
-- nothing else done to it. A session whose header carries no cwd is stored with
-- the empty string: present and countable, which is the point — a session that
-- cannot be attributed has to be visible as such, never quietly missing from a
-- total.
CREATE TABLE IF NOT EXISTS sessions (
  sessionId TEXT PRIMARY KEY,
  project   TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project);

CREATE TABLE IF NOT EXISTS checkpoints (
  sessionId    TEXT PRIMARY KEY,
  consumedSeq  INTEGER NOT NULL,
  logRevision  TEXT,
  cursor       TEXT NOT NULL,
  dshVersion   TEXT,
  updatedAt    INTEGER NOT NULL
) WITHOUT ROWID;
`;

function rangeClause(range = {}, site = undefined, prefix = "") {
	const where = [];
	const params = [];
	if (range.from !== undefined) {
		where.push(`${prefix}day >= ?`);
		params.push(range.from);
	}
	if (range.to !== undefined) {
		where.push(`${prefix}day <= ?`);
		params.push(range.to);
	}
	if (site !== undefined) {
		where.push(`${prefix}site = ?`);
		params.push(site);
	}
	return { sql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "", params };
}

/**
 * A session's project directory, as stored.
 *
 * Only a trailing separator is removed. Resolving symlinks would mean an
 * `fs.realpath` per session per sweep, against directories that may have been
 * deleted since — cost and a failure mode, to merge two spellings of a path
 * that in practice DSH records identically because the header is stamped once
 * at session creation and never rewritten.
 *
 * Absent becomes `''` rather than null: a session with no cwd still gets a row,
 * so it can be counted as unattributed instead of vanishing from the join.
 */
export function normalizeProject(cwd) {
	if (typeof cwd !== "string") return "";
	const trimmed = cwd.trim();
	if (trimmed === "" || trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return trimmed === "" ? "" : trimmed;
	return trimmed.replace(/[\\/]+$/, "");
}

const SUMS = COLUMNS.map((c) => `COALESCE(SUM(${c}), 0) AS ${c}`).join(", ");

function decorate(row) {
	const buckets = {};
	for (const column of COLUMNS) buckets[column] = Number(row[column] ?? 0);
	return { ...row, ...buckets, tokens: totalTokens(buckets), cacheHitRate: cacheHitRate(buckets) };
}

/**
 * The rollup index.
 */
export class LedgerStore {
	#db;
	#stmt = {};

	constructor(db) {
		this.#db = db;
		this.#migrate();
		this.#prepare();
	}

	/**
	 * Open (and migrate) a store.
	 * @param path - database file path, or `:memory:`.
	 */
	static open(path = ":memory:") {
		return new LedgerStore(new DatabaseSync(path));
	}

	#migrate() {
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#db.exec(SCHEMA);
		const found = this.#db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
		if (found === undefined) {
			this.#db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
			return;
		}
		const version = Number(found.value);
		if (version !== SCHEMA_VERSION) {
			// The index is disposable by design, so a version mismatch is discarded
			// rather than migrated. The logs it was built from are untouched.
			this.#db.exec("DELETE FROM session_rollups");
			this.#db.exec("DELETE FROM sessions");
			this.#db.exec("DELETE FROM checkpoints");
			this.#db.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(String(SCHEMA_VERSION));
		}
	}

	#prepare() {
		const cols = COLUMNS.join(", ");
		const marks = COLUMNS.map(() => "?").join(", ");
		this.#stmt.insertRollup = this.#db.prepare(
			`INSERT INTO session_rollups (sessionId, day, site, provider, model, ${cols})
			 VALUES (?, ?, ?, ?, ?, ${marks})`
		);
		this.#stmt.deleteRollups = this.#db.prepare("DELETE FROM session_rollups WHERE sessionId = ?");
		this.#stmt.upsertSession = this.#db.prepare(
			`INSERT INTO sessions (sessionId, project) VALUES (?, ?)
			 ON CONFLICT (sessionId) DO UPDATE SET project = excluded.project`
		);
		this.#stmt.deleteSession = this.#db.prepare("DELETE FROM sessions WHERE sessionId = ?");
		this.#stmt.upsertCheckpoint = this.#db.prepare(
			`INSERT INTO checkpoints (sessionId, consumedSeq, logRevision, cursor, dshVersion, updatedAt)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (sessionId) DO UPDATE SET
			   consumedSeq = excluded.consumedSeq,
			   logRevision = excluded.logRevision,
			   cursor      = excluded.cursor,
			   dshVersion  = excluded.dshVersion,
			   updatedAt   = excluded.updatedAt`
		);
		this.#stmt.deleteCheckpoint = this.#db.prepare("DELETE FROM checkpoints WHERE sessionId = ?");
		this.#stmt.getCheckpoint = this.#db.prepare("SELECT * FROM checkpoints WHERE sessionId = ?");
		this.#stmt.allCheckpoints = this.#db.prepare("SELECT * FROM checkpoints ORDER BY sessionId");
		this.#stmt.sessionRollups = this.#db.prepare("SELECT * FROM session_rollups WHERE sessionId = ?");
	}

	close() {
		this.#db.close();
	}

	#transaction(fn) {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	/** The stored checkpoint for a session, or undefined if never folded. */
	checkpointFor(sessionId) {
		const row = this.#stmt.getCheckpoint.get(sessionId);
		if (row === undefined) return undefined;
		return {
			sessionId: row.sessionId,
			consumedSeq: Number(row.consumedSeq),
			logRevision: row.logRevision ?? undefined,
			dshVersion: row.dshVersion ?? undefined,
			updatedAt: Number(row.updatedAt)
		};
	}

	/** Every stored checkpoint, for discovery and diagnostics. */
	allCheckpoints() {
		return this.#stmt.allCheckpoints.all().map((row) => ({
			sessionId: row.sessionId,
			consumedSeq: Number(row.consumedSeq),
			logRevision: row.logRevision ?? undefined,
			dshVersion: row.dshVersion ?? undefined,
			updatedAt: Number(row.updatedAt)
		}));
	}

	/**
	 * Rehydrate a session's fold state so the next slice of events can be applied
	 * incrementally. Returns a fresh state when the session is unknown, which is
	 * what makes `readFrom(id, 0)` the natural rebuild.
	 */
	loadState(sessionId) {
		const state = createUsageState();
		const checkpoint = this.#stmt.getCheckpoint.get(sessionId);
		if (checkpoint === undefined) return state;

		for (const row of this.#stmt.sessionRollups.all(sessionId)) {
			let entry = state.days.get(row.day);
			if (entry === undefined) {
				entry = { totals: zeroBuckets(), routes: new Map() };
				state.days.set(row.day, entry);
			}
			const buckets = zeroBuckets();
			for (const column of COLUMNS) buckets[column] = Number(row[column]);
			entry.routes.set(routeKey(row.site, row.provider, row.model), buckets);
			for (const column of COLUMNS) entry.totals[column] += buckets[column];
		}

		const cursor = JSON.parse(checkpoint.cursor);
		state.consumedSeq = Number(checkpoint.consumedSeq);
		state.lastSample = cursor.lastSample ?? null;
		state.currentRoute = cursor.currentRoute ?? null;
		return state;
	}

	/**
	 * Persist a session's fold state, replacing whatever was stored for it.
	 *
	 * The rollup replacement and the checkpoint advance happen in one
	 * transaction: a checkpoint that outran its rows would silently skip events
	 * forever, which is the one failure mode this index must not have.
	 */
	commitSession(sessionId, state, options = {}) {
		const cursor = JSON.stringify({ lastSample: state.lastSample, currentRoute: state.currentRoute });
		const updatedAt = options.updatedAt ?? Date.now();
		this.#transaction(() => {
			this.#stmt.deleteRollups.run(sessionId);
			// Written for every swept session, including one with no cwd, so the
			// "which project" question has an answer for all of them — even when
			// that answer is "we do not know".
			this.#stmt.upsertSession.run(sessionId, normalizeProject(options.project));
			for (const [day, entry] of state.days) {
				for (const [key, buckets] of entry.routes) {
					if (COLUMNS.every((column) => buckets[column] === 0)) continue;
					const { site, provider, model } = parseRouteKey(key);
					this.#stmt.insertRollup.run(
						sessionId,
						day,
						site,
						provider,
						model,
						...COLUMNS.map((column) => buckets[column])
					);
				}
			}
			this.#stmt.upsertCheckpoint.run(
				sessionId,
				state.consumedSeq,
				options.logRevision ?? null,
				cursor,
				options.dshVersion ?? null,
				updatedAt
			);
		});
	}

	/** Forget one session entirely — its rows and its checkpoint. */
	dropSession(sessionId) {
		this.#transaction(() => {
			this.#stmt.deleteRollups.run(sessionId);
			this.#stmt.deleteSession.run(sessionId);
			this.#stmt.deleteCheckpoint.run(sessionId);
		});
	}

	/**
	 * Discard the whole index. The next collection pass rebuilds it from
	 * `readFrom(id, 0)`. This is the supported rebuild entry point, not a
	 * last-resort repair.
	 */
	reset() {
		this.#transaction(() => {
			this.#db.exec("DELETE FROM session_rollups");
			this.#db.exec("DELETE FROM sessions");
			this.#db.exec("DELETE FROM checkpoints");
		});
	}

	/** Totals over a date range, optionally restricted to one relay site. */
	totals(range = {}, site = undefined) {
		const { sql, params } = rangeClause(range, site);
		return decorate(this.#db.prepare(`SELECT ${SUMS} FROM session_rollups ${sql}`).get(...params));
	}

	/** Per-day totals, ascending. */
	byDay(range = {}, site = undefined) {
		const { sql, params } = rangeClause(range, site);
		return this.#db
			.prepare(`SELECT day, ${SUMS} FROM session_rollups ${sql} GROUP BY day ORDER BY day`)
			.all(...params)
			.map(decorate);
	}

	/** Per-model totals, descending by billed tokens. Site is a filter. */
	byModel(range = {}, site = undefined) {
		const { sql, params } = rangeClause(range, site);
		return this.#db
			.prepare(`SELECT model, ${SUMS} FROM session_rollups ${sql} GROUP BY model`)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/** Per-site totals — the panel's site breakdown and the report's. */
	bySite(range = {}) {
		const { sql, params } = rangeClause(range);
		return this.#db
			.prepare(`SELECT site, ${SUMS} FROM session_rollups ${sql} GROUP BY site`)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/**
	 * Per-project totals, biggest first.
	 *
	 * A LEFT JOIN, and deliberately so. A rollup row whose session predates the
	 * sessions table — or whose write failed — must still be counted, under `''`,
	 * rather than dropped by an inner join. Usage that silently leaves the totals
	 * is worse than usage nobody can name: the first is invisible, the second is
	 * a row on the panel saying so.
	 */
	byProject(range = {}, site = undefined) {
		const { sql, params } = rangeClause(range, site, "r.");
		return this.#db
			.prepare(
				`SELECT COALESCE(s.project, '') AS project, ${SUMS}
				 FROM session_rollups r LEFT JOIN sessions s ON s.sessionId = r.sessionId
				 ${sql}
				 GROUP BY COALESCE(s.project, '')`
			)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/**
	 * Per-provider-route totals.
	 *
	 * Always available with no configuration at all, because the route name
	 * rides every usage record. Grouping routes into relay sites is a separate,
	 * optional step, kept for cost estimation — basic attribution
	 * should not have to wait for it.
	 */
	byProvider(range = {}, site = undefined) {
		const { sql, params } = rangeClause(range, site);
		return this.#db
			.prepare(`SELECT provider, ${SUMS} FROM session_rollups ${sql} GROUP BY provider`)
			.all(...params)
			.map(decorate)
			.sort((a, b) => b.tokens - a.tokens);
	}

	/** Full route breakdown, for export and drill-down. */
	byRoute(range = {}, site = undefined) {
		const { sql, params } = rangeClause(range, site);
		return this.#db
			.prepare(
				`SELECT day, site, provider, model, ${SUMS} FROM session_rollups ${sql}
				 GROUP BY day, site, provider, model ORDER BY day, site, provider, model`
			)
			.all(...params)
			.map(decorate);
	}

	/**
	 * Index health, for the diagnostics surface. Deliberately counts and
	 * identifiers only — never prompts, tool arguments, credentials, or content.
	 */
	diagnostics() {
		const counts = this.#db
			.prepare(
				`SELECT
				   (SELECT COUNT(*) FROM session_rollups)              AS rollupRows,
				   (SELECT COUNT(DISTINCT sessionId) FROM session_rollups) AS sessionsWithUsage,
				   (SELECT COUNT(*) FROM checkpoints)                  AS sessionsTracked,
				   (SELECT MIN(day) FROM session_rollups)              AS firstDay,
				   (SELECT MAX(day) FROM session_rollups)              AS lastDay,
				   (SELECT MAX(updatedAt) FROM checkpoints)            AS lastUpdatedAt`
			)
			.get();
		const unknownRoutes = this.#db
			.prepare("SELECT COUNT(*) AS n FROM session_rollups WHERE provider = 'unknown' OR model = 'unknown'")
			.get();
		return {
			schemaVersion: SCHEMA_VERSION,
			rollupRows: Number(counts.rollupRows),
			sessionsWithUsage: Number(counts.sessionsWithUsage),
			sessionsTracked: Number(counts.sessionsTracked),
			firstDay: counts.firstDay ?? undefined,
			lastDay: counts.lastDay ?? undefined,
			lastUpdatedAt: counts.lastUpdatedAt === null ? undefined : Number(counts.lastUpdatedAt),
			unattributedRows: Number(unknownRoutes.n)
		};
	}

	/** The full route breakdown as JSON-ready rows. */
	exportJson(range = {}, site = undefined) {
		// Projects ride alongside the route rows rather than as a column on them.
		// A route row is one (day, site, provider, model) cell and a project is a
		// property of the session behind it, so folding one into the other would
		// split every row by a dimension most consumers of this export are not
		// asking about. The CSV keeps only the route table, because a second
		// table inside one CSV is worse than an absent one.
		return { generatedAt: Date.now(), range, site, rows: this.byRoute(range, site), projects: this.byProject(range, site) };
	}

	/** The full route breakdown as CSV. */
	exportCsv(range = {}, site = undefined) {
		const header = ["day", "site", "provider", "model", ...COLUMNS, "tokens", "cacheHitRate"];
		const lines = [header.join(",")];
		for (const row of this.byRoute(range, site)) {
			lines.push(header.map((column) => csvCell(row[column])).join(","));
		}
		return lines.join("\n");
	}
}

function csvCell(value) {
	if (value === null || value === undefined) return "";
	const text = String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
