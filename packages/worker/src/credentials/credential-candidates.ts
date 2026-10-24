/**
 * Which credentials can satisfy a package credential need for the actor
 * (ADR 0068 resolution rules). One module serves `packageGet` needs, the
 * scoped client, call maps, and enablements, so they never disagree.
 *
 * Candidates are credentials of the need's provider that the actor can Use in
 * the run org: org credentials with Use, plus the actor's own personal
 * credentials granted to that org. When resolving for package P, keys bound to
 * P are included too (never keys bound to other packages). When the need
 * declares `kind`, candidates must match it; when `kind` is omitted, any
 * fetch-capable credential (secret/Key, oauth, login) qualifies. A credential
 * with no provider never auto-resolves unless it is a package-bound key whose
 * name matches the need key exactly. Expired Keys stay in the candidate set
 * with `expired: true` so the Credentials UI can show them as bound-but-
 * expired; runtime fill must use `liveUsableCredentials` so expired values
 * are never injected. Nothing here reads a value.
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
import { integrationConnectedSql } from '#worker/integrations/connected.ts'
import {
	isFetchCapableCredentialKind,
	type PackageCredentialKind,
} from '#worker/package-registry/types.ts'
import { type CredentialNeed } from './credential-needs.ts'
import { listPersonalCredentialCandidates } from './personal-credentials.ts'

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
	/** Include package-scope secrets bound to this package id only. */
	packageId: string | null
}

const usableRowQueries = [
	{
		family: 'secret' as const,
		sql: (filter: (column: string) => string, scope: SecretScopeFilter) => {
			const scopeClauses: Array<string> = []
			if (scope.includeUserScope) {
				scopeClauses.push(`(b.scope = 'user' AND b.binding_key = '')`)
			}
			if (scope.packageId) {
				scopeClauses.push(`(b.scope = 'package' AND b.binding_key = ?)`)
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
		binds: (_now: string, scope: SecretScopeFilter) =>
			scope.packageId ? [scope.packageId] : [],
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
				ON a.user_id = i.user_id AND a.slug = i.app_slug AND a.deleted_at IS NULL
			LEFT JOIN platform_oauth_apps p ON p.slug = i.platform_app_slug
			WHERE i.user_id = ? AND i.deleted_at IS NULL
				AND ${integrationConnectedSql('i.connected_at')}${filter('i.id')}`,
		binds: (_now: string, _scope: SecretScopeFilter) => [],
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
}) {
	const secretScope: SecretScopeFilter = input.secretScope ?? {
		includeUserScope: true,
		packageId: null,
	}
	const rows: Array<Row & { family: 'secret' | 'integration' }> = []
	const extraBinds = secretScope.packageId ? 1 : 0
	// ownerId + optional package binding_key; expiry is evaluated in JS.
	const chunks =
		input.ids === null
			? [null]
			: chunkArray(
					[...new Set(input.ids)],
					maxD1BoundParameters - 1 - extraBinds,
				)
	for (const chunk of chunks) {
		if (chunk?.length === 0) continue
		const filter = (column: string) =>
			chunk ? ` AND ${column} IN (${chunk.map(() => '?').join(', ')})` : ''
		for (const query of usableRowQueries) {
			const result = await input.db
				.prepare(query.sql(filter, secretScope))
				.bind(
					input.ownerId,
					...query.binds(input.now, secretScope),
					...(chunk ?? []),
				)
				.all<Row>()
			for (const row of result.results ?? []) {
				if (!needKinds.has(row.kind)) continue
				rows.push({ ...row, family: query.family })
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
}): Promise<UsableCredential | null> {
	const now = (input.now ?? new Date()).toISOString()
	const [row] = await loadRows({
		db: input.db,
		ownerId: input.ownerId,
		ids: [input.id],
		now,
		secretScope: {
			includeUserScope: true,
			packageId: input.packageId ?? null,
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
			packageId: input.packageId ?? null,
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
		})
		credentials.push(
			...personalRows.map((row) => toUsable(row, 'personal', now)),
		)
	}
	return credentials
}

/**
 * Concurrent identical usable-credential lists share one D1 load of org
 * rows, personal grants, and MCP server settings (KODY-AZ). Cleared when the
 * promise settles so a later `storeKey` / grant in the same isolate still
 * re-reads. Package execute's `Promise.all` of `credential(key)` opens hit
 * this after a sync `ownerCredentialOpen` miss, so the in-flight memo
 * coalesces them; it must not outlive the load (tests and runs add
 * credentials between opens on the same request).
 */
const inflightUsableCredentials = new WeakMap<
	D1Database,
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
}) {
	const scopesKey =
		input.scopes === null ? '*' : [...input.scopes].sort().join(',')
	return `${input.orgId}\0${input.actorUserId ?? ''}\0${input.membershipRole ?? ''}\0${input.packageId ?? ''}\0${scopesKey}\0${input.explicitNow ?? ''}`
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
	const db = input.env.APP_DB
	const cacheKey = usableCredentialsCacheKey({
		orgId,
		actorUserId: input.request.actor?.userId,
		membershipRole: input.request.membership?.role,
		packageId: input.packageId,
		scopes: input.request.credential.scopes,
		explicitNow,
	})
	let inflight = inflightUsableCredentials.get(db)
	if (!inflight) {
		inflight = new Map()
		inflightUsableCredentials.set(db, inflight)
	}
	const existing = inflight.get(cacheKey)
	if (existing) return existing
	const pending = loadUsableCredentials({ ...input, now }).finally(() => {
		if (inflight.get(cacheKey) === pending) inflight.delete(cacheKey)
	})
	inflight.set(cacheKey, pending)
	return pending
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
		packageId: input.packageId ?? null,
	}
	// Start the personal-org read in the same turn as listPersonalCredentialCandidates
	// so both share one in-flight users SELECT.
	const personalOrgPromise = actor
		? loadPersonalOrgIdForPerson(input.env.APP_DB, actor)
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
		})
		usable.push(
			...personalRows
				.filter((row) => tokenAllows(row.family))
				.map((row) => toUsable(row, 'personal', now)),
		)
	}
	return usable.sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.scope.localeCompare(right.scope),
	)
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
