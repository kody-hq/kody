/**
 * Which credentials can satisfy a package credential need for the actor
 * (ADR 0068 resolution rules). One module serves `packageGet` needs, the
 * scoped client, call maps, and enablements, so they never disagree.
 *
 * Candidates are credentials of the need's provider that the actor can Use in
 * the run org: org credentials with Use, plus the actor's own personal
 * credentials granted to that org. When resolving for package P, keys bound to
 * P are included too (never keys bound to other packages). When resolving for
 * several packages, `listUsableCredentialsByPackage` loads shared org/personal
 * rows once and batches package-bound Keys (KODY-BD). When the need declares
 * `kind`, candidates must match it; when `kind` is omitted, any fetch-capable
 * credential (secret/Key, oauth, login) qualifies. A credential with no
 * provider never auto-resolves unless it is a package-bound key whose name
 * matches the need key exactly. Expired Keys stay in the candidate set with
 * `expired: true` so the Credentials UI can show them as bound-but-expired;
 * runtime fill must use `liveUsableCredentials` so expired values are never
 * injected. Nothing here reads a value.
 */
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import {
	type OwnerId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	earliestSecretExpiresAt,
	isSecretExpired,
} from '@kody-internal/shared/secret-expires-at.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	listScopeIncludes,
	loadResourceListScope,
} from '#worker/authorization/authorize.ts'
import { getIntegrationAllowedHosts } from '#mcp/execute-modules/integration-host-allowlist.ts'
import {
	integrationConnectedSql,
	integrationUsableInOrgSql,
} from '#worker/integrations/connected.ts'
import {
	isFetchCapableCredentialKind,
	type PackageCredentialKind,
} from '#worker/package-registry/types.ts'
import {
	bumpUsableCredentialsGeneration,
	usableCredentialsGenerationOf,
} from './credential-read-generation.ts'
import { type CredentialNeed } from './credential-needs.ts'
import { listPersonalCredentialCandidates } from './personal-credentials.ts'

export { bumpUsableCredentialsGeneration }

export type UsableCredential = {
	id: string
	name: string
	kind: PackageCredentialKind
	provider: string | null
	hosts: Array<string>
	scope: 'org' | 'personal'
	/** Set when the Key lives in a package-scope bucket bound to that package. */
	packageId: string | null
	/** True when the Key's entry or bucket expiry is at or before now. */
	expired: boolean
}

/** Credentials that a run may still fill; drops expired Keys. */
export function liveUsableCredentials(
	usable: ReadonlyArray<UsableCredential>,
): Array<UsableCredential> {
	return usable.filter((credential) => !credential.expired)
}

type Row = {
	id: string
	name: string
	kind: string
	provider: string | null
	hosts_json: string
	url: string | null
	/** OAuth only: the app's current hosts and API base URL host. */
	app_hosts_json: string | null
	api_base_url: string | null
	bucket_scope: string | null
	binding_key: string | null
	expires_at: string | null
	bucket_expires_at: string | null
}

type SecretScopeFilter = {
	/** Include user-scope (unbound) secrets. */
	includeUserScope: boolean
	/**
	 * Include package-scope secrets bound to these package ids only (never
	 * other packages' Keys). Empty means no package-bound rows.
	 */
	packageIds: ReadonlyArray<string>
}

const usableRowQueries = [
	{
		family: 'secret' as const,
		sql: (filter: (column: string) => string, scope: SecretScopeFilter) => {
			const scopeClauses: Array<string> = []
			if (scope.includeUserScope) {
				scopeClauses.push(`(b.scope = 'user' AND b.binding_key = '')`)
			}
			if (scope.packageIds.length > 0) {
				scopeClauses.push(
					`(b.scope = 'package' AND b.binding_key IN (${scope.packageIds.map(() => '?').join(', ')}))`,
				)
			}
			const scopeSql =
				scopeClauses.length > 0
					? ` AND (${scopeClauses.join(' OR ')})`
					: ` AND 0`
			return `SELECT e.id AS id, e.name AS name, e.kind AS kind, e.provider AS provider,
				e.allowed_hosts AS hosts_json, NULL AS url, NULL AS app_hosts_json,
				NULL AS api_base_url, b.scope AS bucket_scope, b.binding_key AS binding_key,
				e.expires_at AS expires_at, b.expires_at AS bucket_expires_at
			FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ?${scopeSql}
				AND e.deleted_at IS NULL AND b.deleted_at IS NULL
				AND e.encrypted_value IS NOT NULL AND e.encrypted_value != ''
				${filter('e.id')}`
		},
		binds: (_now: string, scope: SecretScopeFilter) => [...scope.packageIds],
	},
	{
		family: 'integration' as const,
		sql: (filter: (column: string) => string, _scope: SecretScopeFilter) =>
			`SELECT i.id AS id, i.name AS name, 'oauth' AS kind, i.provider AS provider,
				i.required_hosts_json AS hosts_json, NULL AS url,
				p.required_hosts_json AS app_hosts_json,
				CASE WHEN i.platform_app_slug IS NOT NULL THEN p.api_base_url
					ELSE a.api_base_url END AS api_base_url,
				NULL AS bucket_scope, NULL AS binding_key,
				NULL AS expires_at, NULL AS bucket_expires_at
			FROM user_integrations i
			LEFT JOIN user_oauth_apps a
				ON a.user_id = COALESCE(i.app_owner_id, i.user_id) AND a.slug = i.app_slug AND a.deleted_at IS NULL
			LEFT JOIN platform_oauth_apps p ON p.slug = i.platform_app_slug
			WHERE i.user_id = ? AND ${integrationUsableInOrgSql('?', 'i')}
				AND i.deleted_at IS NULL
				AND ${integrationConnectedSql('i.connected_at')}${filter('i.id')}`,
		binds: (_now: string, _scope: SecretScopeFilter, runOrgId: string) => [
			runOrgId,
		],
	},
	{
		family: 'integration' as const,
		sql: (filter: (column: string) => string, _scope: SecretScopeFilter) =>
			`SELECT id, name, 'mcp' AS kind, provider, '[]' AS hosts_json, url,
				NULL AS app_hosts_json, NULL AS api_base_url,
				NULL AS bucket_scope, NULL AS binding_key,
				NULL AS expires_at, NULL AS bucket_expires_at
			FROM mcp_server_settings
			WHERE user_id = ? AND deleted_at IS NULL AND enabled = 1${filter('id')}`,
		binds: (_now: string, _scope: SecretScopeFilter) => [],
	},
]

const needKinds = new Set<string>([
	'secret',
	'oauth',
	'mcp',
	'url',
	'login',
	'signing',
] satisfies Array<PackageCredentialKind>)

function parseHostList(json: string | null): Array<string> {
	if (!json) return []
	try {
		const parsed: unknown = JSON.parse(json)
		return Array.isArray(parsed)
			? parsed.filter((host): host is string => typeof host === 'string')
			: []
	} catch {
		return []
	}
}

/**
 * Hosts as the runtime allows them. An OAuth connection adds its app's
 * current hosts and API base URL host to its stored hosts.
 */
function parseHosts(row: Row): Array<string> {
	if (row.url) {
		try {
			return [new URL(row.url).hostname]
		} catch {
			return []
		}
	}
	if (row.kind === 'oauth') {
		return getIntegrationAllowedHosts({
			requiredHosts: [
				...parseHostList(row.hosts_json),
				...parseHostList(row.app_hosts_json),
			],
			apiBaseUrl: row.api_base_url,
		})
	}
	return parseHostList(row.hosts_json)
}

async function loadRows(input: {
	db: D1Database
	ownerId: string
	ids: ReadonlyArray<string> | null
	now: string
	secretScope?: SecretScopeFilter
	/**
	 * Restrict which usable-row families run. Package-bound Key batches use
	 * `['secret']` so org OAuth/MCP lists are not repeated per batch.
	 */
	families?: ReadonlyArray<'secret' | 'integration'>
	/**
	 * Org whose run resolves these rows (defaults to `ownerId`). A personal
	 * connection pinned to an org app loads only in runs of that org.
	 */
	runOrgId?: string
}) {
	const secretScope: SecretScopeFilter = input.secretScope ?? {
		includeUserScope: true,
		packageIds: [],
	}
	const families = new Set(input.families ?? ['secret', 'integration'])
	const rows: Array<Row & { family: 'secret' | 'integration' }> = []
	const uniqueIds = input.ids === null ? null : [...new Set(input.ids)]

	const pushQuery = async (
		query: (typeof usableRowQueries)[number],
		scope: SecretScopeFilter,
		idChunk: ReadonlyArray<string> | null,
	) => {
		if (idChunk?.length === 0) return
		const filter = (column: string) =>
			idChunk ? ` AND ${column} IN (${idChunk.map(() => '?').join(', ')})` : ''
		const result = await input.db
			.prepare(query.sql(filter, scope))
			.bind(
				input.ownerId,
				...query.binds(input.now, scope, input.runOrgId ?? input.ownerId),
				...(idChunk ?? []),
			)
			.all<Row>()
		for (const row of result.results ?? []) {
			if (!needKinds.has(row.kind)) continue
			rows.push({ ...row, family: query.family })
		}
	}

	// Integrations never bind package ids — keep their id-chunk budget at
	// ownerId + runOrgId + ids only.
	if (families.has('integration')) {
		const idChunks =
			uniqueIds === null
				? [null]
				: chunkArray(uniqueIds, maxD1BoundParameters - 2)
		for (const idChunk of idChunks) {
			for (const query of usableRowQueries) {
				if (query.family !== 'integration') continue
				await pushQuery(query, secretScope, idChunk)
			}
		}
	}

	if (!families.has('secret')) return rows

	const secretQuery = usableRowQueries.find(
		(query) => query.family === 'secret',
	)
	if (!secretQuery) return rows

	const packageIds = [...new Set(secretScope.packageIds)]
	const runSecret = async (scope: SecretScopeFilter) => {
		if (!scope.includeUserScope && scope.packageIds.length === 0) return
		// ownerId + package binding keys; leave room for an id IN-list when
		// filtering by credential id (findCredentialById).
		const packageBindCount = scope.packageIds.length
		const idLimit = maxD1BoundParameters - 1 - packageBindCount
		if (uniqueIds !== null && idLimit < 1) {
			// Package binds alone filled the statement — nest package chunks
			// under id chunks of size 1.
			for (const pkgChunk of chunkArray(
				[...scope.packageIds],
				maxD1BoundParameters - 2,
			)) {
				for (const idChunk of chunkArray(uniqueIds, 1)) {
					await pushQuery(
						secretQuery,
						{ includeUserScope: scope.includeUserScope, packageIds: pkgChunk },
						idChunk,
					)
				}
			}
			return
		}
		const idChunks =
			uniqueIds === null ? [null] : chunkArray(uniqueIds, Math.max(1, idLimit))
		for (const idChunk of idChunks) {
			await pushQuery(secretQuery, scope, idChunk)
		}
	}

	// One OR query when user-scope plus package ids fit under the bind cap
	// (the common single-package listUsableCredentials path). Otherwise split
	// so user-scope secrets are not duplicated across package-id chunks.
	const combinedPackageBindCount = packageIds.length
	const combinedIdReserve = uniqueIds === null ? 0 : 1
	const combinedFits =
		secretScope.includeUserScope &&
		packageIds.length > 0 &&
		1 + combinedPackageBindCount + combinedIdReserve <= maxD1BoundParameters

	if (combinedFits) {
		await runSecret({
			includeUserScope: true,
			packageIds,
		})
	} else {
		if (secretScope.includeUserScope) {
			await runSecret({ includeUserScope: true, packageIds: [] })
		}
		if (packageIds.length > 0) {
			const packageChunkSize =
				uniqueIds === null
					? maxD1BoundParameters - 1
					: Math.max(1, maxD1BoundParameters - 2)
			for (const pkgChunk of chunkArray(packageIds, packageChunkSize)) {
				await runSecret({
					includeUserScope: false,
					packageIds: pkgChunk,
				})
			}
		}
	}
	return rows
}

function toUsable(
	row: Row,
	scope: UsableCredential['scope'],
	now: string,
): UsableCredential {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind as PackageCredentialKind,
		provider: row.provider,
		hosts: parseHosts(row),
		scope,
		packageId:
			row.bucket_scope === 'package' && row.binding_key
				? row.binding_key
				: null,
		expired: isSecretExpired(
			earliestSecretExpiresAt(row.expires_at, row.bucket_expires_at),
			new Date(now),
		),
	}
}

/**
 * One live credential of `ownerId` by id, with its kind, provider, and hosts.
 * Says nothing about whether anyone may use it, and reads no value.
 */
export async function findCredentialById(input: {
	db: D1Database
	ownerId: string
	id: string
	scope: UsableCredential['scope']
	now?: Date
	/** When set, also look in that package's bound Key bucket. */
	packageId?: string | null
	/** Org of the run, when it is not `ownerId` (a personal credential). */
	runOrgId?: string
}): Promise<UsableCredential | null> {
	const now = (input.now ?? new Date()).toISOString()
	const [row] = await loadRows({
		db: input.db,
		runOrgId: input.runOrgId,
		ownerId: input.ownerId,
		ids: [input.id],
		now,
		secretScope: {
			includeUserScope: true,
			packageIds: input.packageId ? [input.packageId] : [],
		},
	})
	return row ? toUsable(row, input.scope, now) : null
}

/**
 * Every live credential a run of the org could resolve for some member: the
 * org's own credentials plus each member's personal credentials granted to
 * the org. Says nothing about who may use which, and reads no value.
 */
export async function listOrgReachableCredentials(input: {
	db: D1Database
	orgId: OwnerId
	now?: Date
	/**
	 * When set, also include Keys bound to this package (never other packages'
	 * Keys).
	 */
	packageId?: string | null
}): Promise<Array<UsableCredential>> {
	const now = (input.now ?? new Date()).toISOString()
	const orgRows = await loadRows({
		db: input.db,
		ownerId: input.orgId,
		ids: null,
		now,
		secretScope: {
			includeUserScope: true,
			packageIds: input.packageId ? [input.packageId] : [],
		},
	})
	const credentials = orgRows.map((row) => toUsable(row, 'org', now))
	const grantors = await input.db
		.prepare(
			`SELECT DISTINCT user_id FROM credential_org_grants
			WHERE org_id = ? ORDER BY user_id`,
		)
		.bind(input.orgId)
		.all<{ user_id: string }>()
	for (const { user_id } of grantors.results ?? []) {
		const person = personIdFromStored(user_id)
		const personal = await listPersonalCredentialCandidates({
			db: input.db,
			actorPersonId: person,
			orgId: input.orgId,
		})
		if (personal.length === 0) continue
		const personalRows = await loadRows({
			db: input.db,
			ownerId: await loadPersonalOrgIdForPerson(input.db, person),
			ids: personal.map((credential) => credential.id),
			now,
			runOrgId: input.orgId,
		})
		credentials.push(
			...personalRows.map((row) => toUsable(row, 'personal', now)),
		)
	}
	return credentials
}

/**
 * Usable-credential lists for one `RequestContext` share one D1 load of org
 * rows, personal grants, and MCP server settings (KODY-AZ concurrent opens;
 * KODY-BF sequential opens on the same queue/package execution). Kept for
 * the request so sequential `await credential(key)` reuses the snapshot;
 * keyed by request so another user's or later request never sees this list.
 *
 * A write that can change the usable set bumps
 * `bumpUsableCredentialsGeneration` so the next open on this request
 * re-reads (create-then-open in tests and mid-run storeKey).
 */
const usableCredentialsByRequest = new WeakMap<
	RequestContext,
	Map<string, Promise<Array<UsableCredential>>>
>()

function usableCredentialsCacheKey(input: {
	orgId: string
	actorUserId: string | null | undefined
	membershipRole: string | null | undefined
	packageId: string | null | undefined
	scopes: ReadonlyArray<string> | null
	/** Set only when the caller passed an explicit `now` (expiry boundary). */
	explicitNow: string | null
	generation: number
}) {
	const scopesKey =
		input.scopes === null ? '*' : [...input.scopes].sort().join(',')
	return `${input.orgId}\0${input.actorUserId ?? ''}\0${input.membershipRole ?? ''}\0${input.packageId ?? ''}\0${scopesKey}\0${input.explicitNow ?? ''}\0${input.generation}`
}

/**
 * Every credential the actor can Use in the run org, by kind: the org's own
 * credentials the actor holds Use on, and the actor's own personal
 * credentials granted to the org. In the actor's personal org, its
 * credentials are org credentials. When `packageId` is set, Keys bound to
 * that package are included too.
 */
export async function listUsableCredentials(input: {
	env: Env
	request: RequestContext
	now?: Date
	/**
	 * When set, also include Keys bound to this package (never other packages'
	 * Keys). Pass the package whose needs are being resolved.
	 */
	packageId?: string | null
}): Promise<Array<UsableCredential>> {
	const orgId = input.request.org.id
	const explicitNow = input.now ? input.now.toISOString() : null
	const now = explicitNow ?? new Date().toISOString()
	const cacheKey = usableCredentialsCacheKey({
		orgId,
		actorUserId: input.request.actor?.userId,
		membershipRole: input.request.membership?.role,
		packageId: input.packageId,
		scopes: input.request.credential.scopes,
		explicitNow,
		generation: usableCredentialsGenerationOf(input.env.APP_DB),
	})
	let byKey = usableCredentialsByRequest.get(input.request)
	if (!byKey) {
		byKey = new Map()
		usableCredentialsByRequest.set(input.request, byKey)
	}
	const existing = byKey.get(cacheKey)
	if (existing) return existing
	const pending = loadUsableCredentials({ ...input, now })
	byKey.set(cacheKey, pending)
	pending.catch(() => {
		if (byKey.get(cacheKey) === pending) byKey.delete(cacheKey)
	})
	return pending
}

function compareUsableCredentials(
	left: UsableCredential,
	right: UsableCredential,
) {
	return (
		left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope)
	)
}

async function loadUsableCredentials(input: {
	env: Env
	request: RequestContext
	now: string
	packageId?: string | null
}): Promise<Array<UsableCredential>> {
	const orgId = input.request.org.id
	const { now } = input
	const actor = input.request.actor?.userId ?? null
	const secretScope: SecretScopeFilter = {
		includeUserScope: true,
		packageIds: input.packageId ? [input.packageId] : [],
	}
	// Start the personal-org read in the same turn as listPersonalCredentialCandidates
	// so both share one users SELECT (in-flight + request-scoped).
	const personalOrgPromise = actor
		? loadPersonalOrgIdForPerson(input.env.APP_DB, actor, input.request)
		: Promise.resolve(null)
	const [
		secretScopeAuth,
		integrationScope,
		orgRows,
		personal,
		personalOwnerId,
	] = await Promise.all([
		loadResourceListScope(input, 'secret:use', 'credential'),
		loadResourceListScope(input, 'integration:use', 'credential'),
		loadRows({
			db: input.env.APP_DB,
			ownerId: orgId,
			ids: null,
			now,
			secretScope,
		}),
		listPersonalCredentialCandidates({
			db: input.env.APP_DB,
			actorPersonId: actor,
			orgId: orgId as OwnerId,
		}),
		personalOrgPromise,
	])
	const usable = orgRows
		.filter((row) =>
			listScopeIncludes(
				row.family === 'secret' ? secretScopeAuth : integrationScope,
				row.id,
			),
		)
		.map((row) => toUsable(row, 'org', now))
	// A scoped token narrows personal credentials too: Use of each family.
	const tokenScopes = input.request.credential.scopes
	const tokenAllows = (family: 'secret' | 'integration') =>
		tokenScopes === null || tokenScopes.includes(`${family}:use`)
	if (personalOwnerId && personal.length > 0) {
		const personalRows = await loadRows({
			db: input.env.APP_DB,
			ownerId: personalOwnerId,
			ids: personal.map((credential) => credential.id),
			now,
			runOrgId: orgId,
		})
		usable.push(
			...personalRows
				.filter((row) => tokenAllows(row.family))
				.map((row) => toUsable(row, 'personal', now)),
		)
	}
	return usable.sort(compareUsableCredentials)
}

/**
 * Usable credentials for several packages in one shared org/personal/MCP load
 * plus a batched package-bound Key read (KODY-BD). Each package only receives
 * Keys bound to itself; expired Keys stay in that package's set. Prefer this
 * over N `listUsableCredentials({ packageId })` calls when a request resolves
 * needs across a package list (credentials detail usage, etc.).
 */
export async function listUsableCredentialsByPackage(input: {
	env: Env
	request: RequestContext
	now?: Date
	packageIds: ReadonlyArray<string>
}): Promise<Map<string, Array<UsableCredential>>> {
	const packageIds = [...new Set(input.packageIds.filter(Boolean))]
	const shared = await listUsableCredentials({
		env: input.env,
		request: input.request,
		now: input.now,
	})
	const byPackage = new Map<string, Array<UsableCredential>>()
	for (const packageId of packageIds) {
		byPackage.set(packageId, [...shared])
	}
	if (packageIds.length === 0) return byPackage

	const now = (input.now ?? new Date()).toISOString()
	const [secretScopeAuth, packageRows] = await Promise.all([
		loadResourceListScope(input, 'secret:use', 'credential'),
		loadRows({
			db: input.env.APP_DB,
			ownerId: input.request.org.id,
			ids: null,
			now,
			secretScope: {
				includeUserScope: false,
				packageIds,
			},
			families: ['secret'],
		}),
	])
	for (const row of packageRows) {
		if (!listScopeIncludes(secretScopeAuth, row.id)) continue
		const credential = toUsable(row, 'org', now)
		if (!credential.packageId) continue
		const list = byPackage.get(credential.packageId)
		if (!list) continue
		list.push(credential)
	}
	for (const list of byPackage.values()) {
		list.sort(compareUsableCredentials)
	}
	return byPackage
}

export type NeedResolution = {
	status: 'ready' | 'ambiguous' | 'unbound' | 'expired'
	/** The one candidate that resolves the need with no map entry. */
	autoPick: UsableCredential | null
	/** Credentials matching the need's provider and kind filter. */
	candidates: Array<UsableCredential>
	/** What an explicit pick may name: candidates plus matching-kind credentials with no provider. */
	options: Array<UsableCredential>
	/** Matching-kind credentials with no provider, which a provider would let auto-resolve. */
	possibleMatches: Array<UsableCredential>
}

function autoStatus(credential: UsableCredential): 'ready' | 'expired' {
	return credential.expired ? 'expired' : 'ready'
}

/**
 * Auto-pick when there is exactly one provider-matching candidate, or when a
 * package-bound Key's name matches the need key exactly (sole such match among
 * candidates and null-provider options). Other null-provider credentials stay
 * options only. Live candidates win over expired ones for auto-pick; a sole
 * expired match stays bound with status `expired`.
 */
export function resolveNeedCandidates(
	need: Pick<CredentialNeed, 'kind' | 'provider'> & { key?: string },
	usable: ReadonlyArray<UsableCredential>,
): NeedResolution {
	const matchesKind = (credential: UsableCredential) =>
		need.kind != null
			? credential.kind === need.kind
			: isFetchCapableCredentialKind(credential.kind)
	const sameKind = usable.filter(matchesKind)
	const candidates = sameKind.filter(
		(credential) => credential.provider === need.provider,
	)
	const possibleMatches = sameKind.filter(
		(credential) => credential.provider === null,
	)
	const options = [...candidates, ...possibleMatches]
	const liveCandidates = candidates.filter((credential) => !credential.expired)
	const [onlyLive] = liveCandidates
	const [only] = candidates
	const packageNameMatch =
		need.key != null
			? options.filter(
					(credential) =>
						credential.packageId != null && credential.name === need.key,
				)
			: []
	const livePackageNameMatch = packageNameMatch.filter(
		(credential) => !credential.expired,
	)
	const [packageOnly, packageSecond] = packageNameMatch
	const [livePackageOnly, livePackageSecond] = livePackageNameMatch
	let autoPick: UsableCredential | null = null
	let status: NeedResolution['status']
	// Live matches win for auto-pick so the Credentials tab agrees with
	// runtime fill (`liveUsableCredentials`). Exact-name package-bound Keys
	// still beat a sole provider match when they are live. Expired Keys only
	// bind when nothing live would resolve.
	if (livePackageOnly && !livePackageSecond) {
		autoPick = livePackageOnly
		status = 'ready'
	} else if (liveCandidates.length === 1 && onlyLive) {
		autoPick = onlyLive
		status = 'ready'
	} else if (liveCandidates.length > 1) {
		autoPick = null
		status = 'ambiguous'
	} else if (packageOnly && !packageSecond) {
		autoPick = packageOnly
		status = autoStatus(packageOnly)
	} else if (candidates.length === 1 && only) {
		autoPick = only
		status = autoStatus(only)
	} else if (candidates.length === 0) {
		autoPick = null
		status = 'unbound'
	} else {
		// Several expired-only matches: still bound as expired, not "pick one"
		// among Keys a run will refuse to fill.
		autoPick = null
		status = 'expired'
	}
	return {
		status,
		autoPick,
		candidates,
		options,
		possibleMatches,
	}
}
