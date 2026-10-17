/**
 * Every credential a person sees in the credentials list: Keys and the
 * opt-in stored kinds, OAuth integrations, and MCP servers, as one shape
 * (docs/contributing/contracts/credential-mappings-api.md). Org credentials
 * are filtered by the viewer's list scope; personal rows are only the
 * viewer's own credentials granted to the org. Nothing here reads a value.
 */
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { earliestSecretExpiresAt } from '@kody-internal/shared/secret-expires-at.ts'
import {
	listScopeIncludes,
	loadResourceListScope,
} from '#worker/authorization/authorize.ts'
import { getIntegrationAllowedHosts } from '#mcp/execute-modules/integration-host-allowlist.ts'
import { isReservedSecretName } from '#mcp/secrets/name-guards.ts'
import { oauthCredentialListStatus } from '#worker/integrations/connected.ts'
import {
	type CredentialInjectView,
	type CredentialKind,
	type CredentialListFilters,
	type CredentialListItem,
	type CredentialScope,
	isCredentialKind,
} from '#universal/credential-contracts.ts'
import { filterCredentialList } from '#universal/credentials-list.ts'
import {
	readCredentialFillPlacement,
	readCredentialInject,
} from './credential-fields.ts'
import { listPersonalCredentialCandidates } from './personal-credentials.ts'

type Family = 'secret' | 'integration'

type ListedRow = Omit<CredentialListItem, 'scope'> & { family: Family }

function parseStringArray(json: string | null): Array<string> {
	if (!json) return []
	try {
		const parsed: unknown = JSON.parse(json)
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === 'string')
			: []
	} catch {
		return []
	}
}

function hostOf(url: string): Array<string> {
	try {
		return [new URL(url).hostname]
	} catch {
		return []
	}
}

const bearerInject: CredentialInjectView = {
	kind: 'header',
	name: 'Authorization',
	format: 'Bearer {value}',
}

type IdFilter = { sql: string; binds: Array<string> }

/**
 * Runs `query` once with no id filter, or once per chunk of `ids` so each
 * statement stays under D1's bound-parameter cap. `fixedBinds` counts the
 * query's other bound parameters.
 */
async function queryByIds<Row>(
	column: string,
	ids: ReadonlyArray<string> | null,
	fixedBinds: number,
	query: (filter: IdFilter) => Promise<Array<Row>>,
): Promise<Array<Row>> {
	if (ids === null) return query({ sql: '', binds: [] })
	const groups = await Promise.all(
		chunkArray([...new Set(ids)], maxD1BoundParameters - fixedBinds).map(
			(chunk) =>
				query({
					sql: ` AND ${column} IN (${chunk.map(() => '?').join(', ')})`,
					binds: chunk,
				}),
		),
	)
	return groups.flat()
}

type SecretRow = {
	id: string
	name: string
	kind: string
	provider: string | null
	description: string
	allowed_hosts: string
	allowed_packages: string
	inject_json: string | null
	placement_json: string | null
	bucket_scope: string
	binding_key: string
	created_at: string
	updated_at: string
	expires_at: string | null
	bucket_expires_at: string | null
}

async function loadSecretRows(input: {
	db: D1Database
	ownerId: string
	ids: ReadonlyArray<string> | null
	now: string
}): Promise<Array<ListedRow>> {
	const rows = await queryByIds('e.id', input.ids, 1, async (filter) => {
		const result = await input.db
			.prepare(
				`SELECT e.id, e.name, e.kind, e.provider, e.description, e.allowed_hosts,
					e.allowed_packages, e.inject_json, e.placement_json, b.scope AS bucket_scope,
					b.binding_key, e.created_at, e.updated_at, e.expires_at,
					b.expires_at AS bucket_expires_at
				FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
				WHERE b.user_id = ? AND b.scope IN ('user', 'package')
					AND e.deleted_at IS NULL AND b.deleted_at IS NULL
					AND e.id IS NOT NULL${filter.sql}`,
			)
			.bind(input.ownerId, ...filter.binds)
			.all<SecretRow>()
		return result.results ?? []
	})
	return rows.flatMap((row): Array<ListedRow> => {
		if (isReservedSecretName(row.name) || !isCredentialKind(row.kind)) {
			return []
		}
		const kind: CredentialKind = row.kind
		const expiresAt = earliestSecretExpiresAt(
			row.expires_at,
			row.bucket_expires_at,
		)
		const expired = expiresAt !== null && expiresAt <= input.now
		return [
			{
				family: 'secret',
				id: row.id,
				kind,
				name: row.name,
				provider: row.provider,
				description: row.description,
				hosts: parseStringArray(row.allowed_hosts),
				inject:
					kind === 'secret' || kind === 'login'
						? readCredentialInject(row.inject_json)
						: null,
				placement: readCredentialFillPlacement(row.placement_json),
				packageId: row.bucket_scope === 'package' ? row.binding_key : null,
				lockedToPackageIds: parseStringArray(row.allowed_packages),
				expiresAt,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				status: expired ? 'expired' : 'ok',
				statusMessage: expired ? 'This credential has expired.' : null,
				mcp: null,
			},
		]
	})
}

type IntegrationRow = {
	id: string
	name: string
	provider: string | null
	description: string
	required_hosts_json: string
	app_hosts_json: string | null
	api_base_url: string | null
	usage_mode: string
	allowed_packages_json: string
	placement_json: string | null
	connected_at: string | null
	auth_failed_at: string | null
	auth_failed_reason: string | null
	created_at: string
	updated_at: string
}

async function loadIntegrationRows(input: {
	db: D1Database
	ownerId: string
	ids: ReadonlyArray<string> | null
}): Promise<Array<ListedRow>> {
	const rows = await queryByIds('i.id', input.ids, 1, async (filter) => {
		const result = await input.db
			.prepare(
				`SELECT i.id, i.name, COALESCE(i.provider, p.provider, a.provider) AS provider,
				i.description, i.required_hosts_json,
				p.required_hosts_json AS app_hosts_json,
				CASE WHEN i.platform_app_slug IS NOT NULL THEN p.api_base_url
					ELSE a.api_base_url END AS api_base_url,
				i.usage_mode, i.allowed_packages_json, i.placement_json, i.connected_at,
				i.auth_failed_at, i.auth_failed_reason, i.created_at, i.updated_at
			FROM user_integrations i
			LEFT JOIN user_oauth_apps a
				ON a.user_id = i.user_id AND a.slug = i.app_slug AND a.deleted_at IS NULL
			LEFT JOIN platform_oauth_apps p ON p.slug = i.platform_app_slug
			WHERE i.user_id = ? AND i.deleted_at IS NULL
				AND i.id IS NOT NULL${filter.sql}`,
			)
			.bind(input.ownerId, ...filter.binds)
			.all<IntegrationRow>()
		return result.results ?? []
	})
	return rows.map((row): ListedRow => {
		const { status, statusMessage } = oauthCredentialListStatus({
			connectedAt: row.connected_at,
			authFailedAt: row.auth_failed_at,
			authFailedReason: row.auth_failed_reason,
		})
		return {
			family: 'integration',
			id: row.id,
			kind: 'oauth',
			name: row.name,
			provider: row.provider,
			description: row.description,
			hosts: getIntegrationAllowedHosts({
				requiredHosts: [
					...parseStringArray(row.required_hosts_json),
					...parseStringArray(row.app_hosts_json),
				],
				apiBaseUrl: row.api_base_url,
			}),
			inject: bearerInject,
			placement: readCredentialFillPlacement(row.placement_json),
			packageId: null,
			lockedToPackageIds:
				row.usage_mode === 'packages'
					? parseStringArray(row.allowed_packages_json)
					: [],
			expiresAt: null,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			status,
			statusMessage,
			mcp: null,
		}
	})
}

type McpRow = {
	id: string
	name: string
	url: string
	provider: string | null
	enabled: number
	usage_mode: string
	allowed_packages_json: string
	last_error: string | null
	created_at: string
	updated_at: string
}

async function loadMcpRows(input: {
	db: D1Database
	ownerId: string
	ids: ReadonlyArray<string> | null
}): Promise<Array<ListedRow>> {
	const rows = await queryByIds('id', input.ids, 1, async (filter) => {
		const result = await input.db
			.prepare(
				`SELECT id, name, url, provider, enabled, usage_mode,
					allowed_packages_json, last_error, created_at, updated_at
				FROM mcp_server_settings
				WHERE user_id = ? AND deleted_at IS NULL${filter.sql}`,
			)
			.bind(input.ownerId, ...filter.binds)
			.all<McpRow>()
		return result.results ?? []
	})
	return rows.map((row): ListedRow => {
		const enabled = row.enabled === 1
		return {
			family: 'integration',
			id: row.id,
			kind: 'mcp',
			name: row.name,
			provider: row.provider,
			description: '',
			hosts: hostOf(row.url),
			inject: null,
			placement: null,
			packageId: null,
			lockedToPackageIds:
				row.usage_mode === 'packages'
					? parseStringArray(row.allowed_packages_json)
					: [],
			expiresAt: null,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			status: !enabled ? 'disabled' : row.last_error ? 'needs_attention' : 'ok',
			statusMessage: !enabled
				? 'Turned off.'
				: row.last_error
					? 'The last connection attempt failed.'
					: null,
			mcp: { url: row.url, enabled },
		}
	})
}

async function loadOwnerRows(input: {
	db: D1Database
	ownerId: string
	ids: ReadonlyArray<string> | null
	now: string
}) {
	if (input.ids?.length === 0) return []
	const groups = await Promise.all([
		loadSecretRows(input),
		loadIntegrationRows(input),
		loadMcpRows(input),
	])
	return groups.flat()
}

/**
 * The viewer's credentials list for the request's org, sorted by name then
 * scope. Personal rows follow a scoped token's Use scopes like the resolver.
 */
export async function listCredentialsForViewer(input: {
	env: Env
	request: RequestContext
	filters?: CredentialListFilters
	now?: Date
}): Promise<Array<CredentialListItem>> {
	const db = input.env.APP_DB
	const orgId = input.request.org.id
	const now = (input.now ?? new Date()).toISOString()
	const actor = input.request.actor?.userId ?? null
	const [secretScope, integrationScope, packageScope, orgRows, personal] =
		await Promise.all([
			loadResourceListScope(input, 'secret:use', 'credential'),
			loadResourceListScope(input, 'integration:read', 'credential'),
			loadResourceListScope(input, 'package:read', 'package'),
			loadOwnerRows({ db, ownerId: orgId, ids: null, now }),
			listPersonalCredentialCandidates({
				db,
				actorPersonId: actor,
				orgId: orgId as OwnerId,
			}),
		])
	const withScope = (
		row: ListedRow,
		scope: CredentialScope,
	): CredentialListItem => {
		const item: CredentialListItem & { family?: Family } = { ...row, scope }
		delete item.family
		return item
	}
	const items: Array<CredentialListItem> = orgRows
		.filter(
			(row) =>
				listScopeIncludes(
					row.family === 'secret' ? secretScope : integrationScope,
					row.id,
				) &&
				// A package Key is that package's own; org-wide Use alone does
				// not reveal it to someone who cannot read the package.
				(row.packageId === null ||
					listScopeIncludes(packageScope, row.packageId)),
		)
		.map((row) => withScope(row, 'org'))
	if (actor && personal.length > 0) {
		const tokenScopes = input.request.credential.scopes
		const tokenAllows = (family: Family) =>
			tokenScopes === null ||
			tokenScopes.includes(
				family === 'secret' ? 'secret:use' : 'integration:use',
			)
		const personalRows = await loadOwnerRows({
			db,
			ownerId: await loadPersonalOrgIdForPerson(db, actor),
			ids: personal.map((credential) => credential.id),
			now,
		})
		items.push(
			...personalRows
				// credential() refuses a personal MCP server, so it is not usable here.
				.filter(
					(row) =>
						row.packageId === null &&
						row.kind !== 'mcp' &&
						tokenAllows(row.family),
				)
				.map((row) => withScope(row, 'personal')),
		)
	}
	items.sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.scope.localeCompare(right.scope) ||
			left.kind.localeCompare(right.kind),
	)
	return input.filters ? filterCredentialList(items, input.filters) : items
}
