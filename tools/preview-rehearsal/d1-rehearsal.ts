import {
	assertPreviewResourceName,
	buildPreviewResourceNames,
	previewResourceNamePattern,
} from '../ci/preview-resources.ts'
import { cloudflareApiRequest } from '../ci/resource-utils.ts'

export type CloudflareClient = {
	accountId: string
	apiToken: string
	apiBaseUrl?: string
	fetcher?: typeof fetch
	sleep?: (ms: number) => Promise<void>
}

const rehearsalDatabaseRoles = ['app', 'audit', 'jobs'] as const
type RehearsalDatabaseRole = (typeof rehearsalDatabaseRoles)[number]

export type RehearsalDatabase = {
	role: RehearsalDatabaseRole
	name: string
	uuid: string
}

type D1TableCount = { table: string; rows: number }

type D1DatabaseSnapshot = RehearsalDatabase & {
	bookmark: string
	tables: Array<D1TableCount>
}

export type D1RehearsalSnapshot = {
	version: 1
	workerName: string
	takenAt: string
	databases: Array<D1DatabaseSnapshot>
}

const branchPreviewPattern = /^kody-branch-[a-z0-9]+(?:-[a-z0-9]+)*$/
const previewSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const pullRequestPreviewPattern = /^kody-pr-\d+$/

/** Same cap as `preview.yml` (`cut -c1-32`) before it prefixes `kody-branch-`. */
export const previewBranchSlugMaxLength = 32

/**
 * Rehearsals run only on dedicated branch previews (`kody-branch-*`): PR
 * previews redeploy and reseed on every push, and a restore there would race
 * the PR's own deploys.
 */
export function assertRehearsalWorkerName(workerName: string) {
	if (
		!branchPreviewPattern.test(workerName) ||
		!previewResourceNamePattern.test(workerName)
	) {
		throw new Error(
			`Refusing to rehearse on "${workerName}": rehearsals run only on branch previews named kody-branch-<slug>.`,
		)
	}
	return workerName
}

/**
 * `preview.yml` takes the slug (`cig-0110`) and prefixes `kody-branch-`.
 * Rehearsal dispatch often reuses that same input. Accept either form and
 * return the worker name the rest of the tooling already requires.
 */
export function resolveRehearsalWorkerName(input: string) {
	const workerName = input.trim().toLowerCase()
	if (branchPreviewPattern.test(workerName)) {
		return assertRehearsalWorkerName(workerName)
	}
	if (pullRequestPreviewPattern.test(workerName)) {
		throw new Error(
			`Refusing to rehearse on "${input}": rehearsals run only on branch previews named kody-branch-<slug>.`,
		)
	}
	if (previewSlugPattern.test(workerName)) {
		return assertRehearsalWorkerName(
			`kody-branch-${workerName.slice(0, previewBranchSlugMaxLength)}`,
		)
	}
	throw new Error(
		`Refusing to rehearse on "${input}": rehearsals run only on branch previews named kody-branch-<slug> or the slug preview.yml uses.`,
	)
}

/**
 * Workflow concurrency key for a dispatch input. Slug and full worker name
 * lock the same preview. GitHub Actions evaluates `concurrency.group` before
 * jobs run, so the workflow expression prefixes the same way.
 */
export function rehearsalConcurrencyGroup(input: string) {
	return `preview-rehearsal-${resolveRehearsalWorkerName(input)}`
}

function rehearsalDatabaseNames(workerName: string) {
	assertRehearsalWorkerName(workerName)
	const names = buildPreviewResourceNames(workerName)
	const byRole: Record<RehearsalDatabaseRole, string> = {
		app: names.d1DatabaseName,
		audit: names.auditD1DatabaseName,
		jobs: names.jobsD1DatabaseName,
	}
	for (const name of Object.values(byRole))
		assertPreviewResourceName(name, 'd1')
	return byRole
}

export async function resolveRehearsalDatabases(
	client: CloudflareClient,
	workerName: string,
): Promise<Array<RehearsalDatabase>> {
	const names = rehearsalDatabaseNames(workerName)
	const databases: Array<RehearsalDatabase> = []
	for (const role of rehearsalDatabaseRoles) {
		const name = names[role]
		const response = await cloudflareApiRequest<
			Array<{ uuid: string; name: string }>
		>({
			...client,
			pathname: `/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
		})
		const match = (response.result ?? []).find((entry) => entry.name === name)
		if (!match) {
			throw new Error(
				`D1 database ${name} (${role}) does not exist. Deploy the preview first.`,
			)
		}
		databases.push({ role, name, uuid: match.uuid })
	}
	return databases
}

type D1StatementPayload<Row> = {
	results?: Array<Row>
	success?: boolean
	meta?: { changes?: number }
}

async function postD1Query<Row>(
	client: CloudflareClient,
	uuid: string,
	sql: string,
	params?: ReadonlyArray<string | number | null>,
) {
	const response = await cloudflareApiRequest<Array<D1StatementPayload<Row>>>({
		...client,
		pathname: `/d1/database/${uuid}/query`,
		method: 'POST',
		body: {
			sql,
			...(params && params.length > 0 ? { params: [...params] } : {}),
		},
	})
	const statements = response.result ?? []
	for (const statement of statements) {
		if (statement.success === false) {
			throw new Error(
				`D1 statement failed: ${sql.trim().replace(/\s+/g, ' ').slice(0, 180)}`,
			)
		}
	}
	return statements
}

export async function queryD1<Row>(
	client: CloudflareClient,
	uuid: string,
	sql: string,
	params?: ReadonlyArray<string | number | null>,
): Promise<Array<Row>> {
	const statements = await postD1Query<Row>(client, uuid, sql, params)
	return statements.flatMap((statement) => statement.results ?? [])
}

function quoteIdentifier(name: string) {
	return `"${name.replaceAll('"', '""')}"`
}

/**
 * D1 compiles SQLite with SQLITE_LIMIT_COMPOUND_SELECT = 5. A larger UNION ALL
 * fails with `too many terms in compound SELECT`.
 */
const d1CompoundSelectLimit = 5

/** Row counts for every user table (SQLite and Cloudflare internals skipped). */
async function countD1Tables(
	client: CloudflareClient,
	uuid: string,
): Promise<Array<D1TableCount>> {
	const tables = await queryD1<{ name: string }>(
		client,
		uuid,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
	)
	const counts: Array<D1TableCount> = []
	for (let index = 0; index < tables.length; index += d1CompoundSelectLimit) {
		const batch = tables.slice(index, index + d1CompoundSelectLimit)
		const sql = batch
			.map(
				({ name }) =>
					`SELECT '${name.replaceAll("'", "''")}' AS table_name, COUNT(*) AS row_count FROM ${quoteIdentifier(name)}`,
			)
			.join(' UNION ALL ')
		const rows = await queryD1<{ table_name: string; row_count: number }>(
			client,
			uuid,
			sql,
		)
		for (const row of rows) {
			counts.push({ table: row.table_name, rows: Number(row.row_count) })
		}
	}
	return counts.sort((a, b) => a.table.localeCompare(b.table))
}

async function getD1Bookmark(client: CloudflareClient, uuid: string) {
	const response = await cloudflareApiRequest<{ bookmark?: string }>({
		...client,
		pathname: `/d1/database/${uuid}/time_travel/bookmark`,
	})
	const bookmark = response.result?.bookmark
	if (!bookmark) throw new Error(`D1 ${uuid} returned no Time Travel bookmark.`)
	return bookmark
}

async function restoreD1Bookmark(
	client: CloudflareClient,
	database: RehearsalDatabase,
	bookmark: string,
) {
	assertPreviewResourceName(database.name, 'd1')
	const response = await cloudflareApiRequest<{
		bookmark?: string
		previous_bookmark?: string
		message?: string
	}>({
		...client,
		pathname: `/d1/database/${database.uuid}/time_travel/restore?bookmark=${encodeURIComponent(bookmark)}`,
		method: 'POST',
	})
	return {
		bookmark: response.result?.bookmark ?? bookmark,
		previousBookmark: response.result?.previous_bookmark ?? null,
		message: response.result?.message ?? '',
	}
}

export async function takeD1RehearsalSnapshot(
	client: CloudflareClient,
	workerName: string,
	now: () => Date = () => new Date(),
): Promise<D1RehearsalSnapshot> {
	const databases = await resolveRehearsalDatabases(client, workerName)
	const snapshots: Array<D1DatabaseSnapshot> = []
	for (const database of databases) {
		// Bookmark first: counts taken after it describe the bookmarked state
		// unless a write lands in between, which the run summary would show.
		const bookmark = await getD1Bookmark(client, database.uuid)
		const tables = await countD1Tables(client, database.uuid)
		snapshots.push({ ...database, bookmark, tables })
	}
	return {
		version: 1,
		workerName,
		takenAt: now().toISOString(),
		databases: snapshots,
	}
}

export function parseD1RehearsalSnapshot(raw: string): D1RehearsalSnapshot {
	const parsed = JSON.parse(raw) as Partial<D1RehearsalSnapshot>
	if (
		parsed.version !== 1 ||
		typeof parsed.workerName !== 'string' ||
		!Array.isArray(parsed.databases)
	) {
		throw new Error('Not a version 1 D1 rehearsal snapshot.')
	}
	for (const database of parsed.databases) {
		if (
			!rehearsalDatabaseRoles.includes(database.role) ||
			typeof database.bookmark !== 'string' ||
			typeof database.uuid !== 'string' ||
			typeof database.name !== 'string' ||
			!Array.isArray(database.tables)
		) {
			throw new Error('D1 rehearsal snapshot has a malformed database entry.')
		}
	}
	const roles = new Set(parsed.databases.map((database) => database.role))
	if (roles.size !== parsed.databases.length) {
		throw new Error('D1 rehearsal snapshot has duplicate database roles.')
	}
	return parsed as D1RehearsalSnapshot
}

/**
 * Restore every rehearsal D1 to the bookmarks in `snapshot`. The snapshot must
 * belong to `workerName`, and the live database uuids must match the ones the
 * snapshot recorded (a recreated database has a new uuid and no history).
 */
export async function restoreD1RehearsalSnapshot(
	client: CloudflareClient,
	workerName: string,
	snapshot: D1RehearsalSnapshot,
) {
	if (snapshot.workerName !== workerName) {
		throw new Error(
			`Snapshot belongs to ${snapshot.workerName}, not ${workerName}.`,
		)
	}
	const live = await resolveRehearsalDatabases(client, workerName)
	// Check every database before restoring any, so a partly recreated preview
	// never ends up with some databases rolled back and others not.
	const plan = live.map((database) => {
		const recorded = snapshot.databases.find(
			(entry) => entry.role === database.role,
		)
		if (!recorded) {
			throw new Error(`Snapshot has no ${database.role} database bookmark.`)
		}
		if (recorded.uuid !== database.uuid || recorded.name !== database.name) {
			throw new Error(
				`${database.name} was recreated since the snapshot (uuid ${recorded.uuid} -> ${database.uuid}); its Time Travel history does not include the bookmark.`,
			)
		}
		return { database, recorded }
	})
	const results: Array<{
		role: RehearsalDatabaseRole
		name: string
		restoredTo: string
		previousBookmark: string | null
		message: string
	}> = []
	for (const { database, recorded } of plan) {
		const restored = await restoreD1Bookmark(
			client,
			database,
			recorded.bookmark,
		)
		results.push({
			role: database.role,
			name: database.name,
			restoredTo: recorded.bookmark,
			previousBookmark: restored.previousBookmark,
			message: restored.message,
		})
	}
	return results
}

export function formatD1SnapshotMarkdown(snapshot: D1RehearsalSnapshot) {
	const lines = [
		`### D1 snapshot for \`${snapshot.workerName}\``,
		'',
		`Taken at ${snapshot.takenAt}.`,
		'',
		'| Database | Role | Bookmark |',
		'| --- | --- | --- |',
		...snapshot.databases.map(
			(database) =>
				`| \`${database.name}\` | ${database.role} | \`${database.bookmark}\` |`,
		),
	]
	for (const database of snapshot.databases) {
		lines.push(
			'',
			`<details><summary>${database.role}: ${database.tables.length} tables, ${database.tables.reduce((sum, table) => sum + table.rows, 0)} rows</summary>`,
			'',
			'| Table | Rows |',
			'| --- | ---: |',
			...database.tables.map(
				(table) => `| \`${table.table}\` | ${table.rows} |`,
			),
			'',
			'</details>',
		)
	}
	return `${lines.join('\n')}\n`
}
