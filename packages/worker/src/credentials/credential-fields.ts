/**
 * The fields a credential owns for the opt-in types (ADR 0068): its provider,
 * how a scoped client places it (`inject`), and, for the `url`, `login`, and
 * `signing` kinds, its kind, hosts, and login exchange. Key placeholders
 * ignore `provider` and `inject` and keep their own placement.
 *
 * Only the credential's manager edits these, and every edit is audited. Hosts
 * are set only together with a new value: whoever supplies the value decides
 * where it may go, and an existing value's hosts keep the approval flow.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getDomain, getPublicSuffix } from 'tldts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	type OrgAuditWriter,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { getOrgCredential, type OrgCredential } from './credential-ids.ts'
import { credentialHostsAllow } from './credential-request.ts'
import {
	type CredentialFillPlacement,
	readCredentialFillPlacement,
	serializeCredentialFillPlacement,
} from './fill-placement.ts'
import { loginExchangeSchema } from './login-resolver.ts'
import {
	assertOptInCredentialValue,
	type OptInStoredCredentialKind,
	optInStoredCredentialKinds,
} from './opt-in-credential-value.ts'

export {
	type CredentialFillPlacement,
	credentialFillPlacementSchema,
	defaultNewCredentialFillPlacement,
	fillPlacementAllows,
	fillPlacementPartLabels,
	readCredentialFillPlacement,
	serializeCredentialFillPlacement,
	type CredentialFillSite,
} from './fill-placement.ts'

/** RFC 9110 token characters for HTTP field names. */
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export const credentialProviderSchema = z
	.string()
	.regex(
		/^[a-z0-9-]{1,64}$/,
		'A provider is a slug: lowercase letters, numbers, and hyphens (for example "github").',
	)

export const credentialInjectSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('header'),
		name: z.string().regex(httpFieldNamePattern),
		format: z
			.string()
			.max(200)
			.refine((format) => format.split('{value}').length === 2, {
				message: 'An inject format holds "{value}" exactly once.',
			}),
	}),
	z.strictObject({
		kind: z.literal('basic'),
		valueAs: z.enum(['username', 'password']),
		other: z.string().max(200).default(''),
	}),
	z.strictObject({
		kind: z.literal('query'),
		param: z.string().min(1).max(100),
	}),
])

export type CredentialInject = z.infer<typeof credentialInjectSchema>

export const defaultCredentialInject: CredentialInject = {
	kind: 'header',
	name: 'Authorization',
	format: 'Bearer {value}',
}

export { type OptInStoredCredentialKind, optInStoredCredentialKinds }

const hostLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const bareHostPattern = new RegExp(
	`^(?:\\*\\.)?${hostLabel}(?:\\.${hostLabel})+$`,
)

/**
 * A bare host or one wildcard level, lowercased. Anything URL-shaped (scheme,
 * port, path, userinfo) is refused rather than reduced to its hostname, so a
 * host list never looks narrower than what it allows.
 */
function normalizeCredentialHost(host: string) {
	const candidate = host.trim().toLowerCase()
	if (!bareHostPattern.test(candidate)) return null
	if (candidate.startsWith('*.')) {
		// `*.github.io` would reach every site on the suffix, not one owner's hosts.
		const base = candidate.slice(2)
		const options = { allowPrivateDomains: true }
		if (getPublicSuffix(base, options) === base || !getDomain(base, options)) {
			return null
		}
	}
	return candidate
}

/** Exact hosts or one wildcard level (`*.example.com`). */
export const credentialHostsSchema = z
	.array(z.string().min(1).max(253))
	.min(1)
	.max(20)
	.superRefine((hosts, ctx) => {
		for (const host of hosts) {
			if (normalizeCredentialHost(host)) continue
			ctx.addIssue({
				code: 'custom',
				message: `"${host}" is not a bare host. Use an exact host such as api.example.com or one wildcard level under a registrable domain such as *.example.com (not *.github.io), with no scheme, port, or path.`,
			})
		}
	})

/** Lowercased, deduplicated hosts from input `credentialHostsSchema` accepted. */
export function normalizeCredentialHosts(hosts: ReadonlyArray<string>) {
	return [
		...new Set(
			hosts
				.map(normalizeCredentialHost)
				.filter((host): host is string => host !== null),
		),
	]
}

export { loginExchangeSchema }
export { assertOptInCredentialValue }

export function assertLoginExchangeOnHosts(input: {
	exchangeUrl: string
	hosts: ReadonlyArray<string>
}) {
	let url: URL
	try {
		url = new URL(input.exchangeUrl)
	} catch {
		throw new McpCallerError('The login exchange url is not a valid URL.')
	}
	if (url.protocol !== 'https:') {
		throw new McpCallerError('The login exchange url must use https://.')
	}
	if (url.username || url.password) {
		throw new McpCallerError(
			'The login exchange url cannot carry a username or password.',
		)
	}
	if (!credentialHostsAllow(input.hosts, url.hostname)) {
		throw new McpCallerError(
			"The login exchange url's host must be one of the credential's hosts.",
		)
	}
}

const fieldTables = {
	secret: 'secret_entries',
	integration: 'user_integrations',
	'mcp-server': 'mcp_server_settings',
	vault: 'secret_provider_bindings',
} as const satisfies Record<OrgCredential['kind'], string>

/** Tables that store placeholder fill placement (not MCP servers). */
const placementFieldTables = {
	secret: 'secret_entries',
	integration: 'user_integrations',
	vault: 'secret_provider_bindings',
} as const satisfies Partial<Record<OrgCredential['kind'], string>>

const storedKindValues = ['secret', ...optInStoredCredentialKinds] as const

export type StoredCredentialKindValue = (typeof storedKindValues)[number]

function parseStoredKind(value: unknown): StoredCredentialKindValue {
	const kind = storedKindValues.find((candidate) => candidate === value)
	if (!kind) throw new Error(`Unknown stored credential kind: ${String(value)}`)
	return kind
}

/**
 * A login credential's session token is placed by header or query only; the
 * login resolver has no Basic placement, so refuse it at write time.
 */
export function assertInjectFitsKind(input: {
	kind: StoredCredentialKindValue
	inject: CredentialInject
}) {
	if (input.kind === 'login' && input.inject.kind === 'basic') {
		throw new McpCallerError(
			'A login credential places its session token in a header or query parameter, not basic auth.',
		)
	}
}

function parseInject(injectJson: string | null | undefined): CredentialInject {
	return readCredentialInject(injectJson) ?? defaultCredentialInject
}

/** A stored `inject_json`, or null when it is not a valid inject. */
export function readCredentialInject(
	injectJson: string | null | undefined,
): CredentialInject | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(injectJson ?? 'null')
	} catch {
		return null
	}
	const inject = credentialInjectSchema.safeParse(parsed)
	return inject.success ? inject.data : null
}

export type CredentialFieldsUpdate = {
	provider?: string | null
	inject?: CredentialInject
	/**
	 * Placeholder fill placement. `undefined` leaves the stored value alone;
	 * `null` clears it back to anywhere.
	 */
	placement?: CredentialFillPlacement | null
}

export type CredentialFields = {
	credential: OrgCredential
	provider: string | null
	inject: CredentialInject
	/** Null means anywhere (placeholders may fill any request part). */
	placement: CredentialFillPlacement | null
}

async function readFields(db: D1Database, credential: OrgCredential) {
	const isSecret = credential.kind === 'secret'
	const hasPlacement = credential.kind in placementFieldTables
	const row = await db
		.prepare(
			`SELECT provider, inject_json${isSecret ? ', kind' : ''}${
				hasPlacement ? ', placement_json' : ''
			}
			FROM ${fieldTables[credential.kind]} WHERE id = ?`,
		)
		.bind(credential.id)
		.first<{
			provider: string | null
			inject_json: string
			kind?: string
			placement_json?: string | null
		}>()
	return {
		credential,
		provider: row?.provider ?? null,
		inject: parseInject(row?.inject_json),
		placement: hasPlacement
			? readCredentialFillPlacement(row?.placement_json)
			: null,
		storedKind: isSecret ? parseStoredKind(row?.kind) : null,
	}
}

/**
 * Sets `provider`, `inject`, and/or placeholder `placement` on one credential
 * of `orgId`, committed together with its audit event. The caller has already
 * authorized the manager's write permission.
 */
export async function updateCredentialFields(input: {
	db: D1Database
	orgId: OwnerId
	credentialId: string
	update: CredentialFieldsUpdate
	audit: OrgAuditWriter
	/**
	 * How a secret placement change was chosen. Account UI passes `owner`
	 * (default); MCP `credentialUpdate` passes `explicit`.
	 */
	placementOrigin?: 'owner' | 'explicit'
}): Promise<CredentialFields> {
	const credential = await getOrgCredential(
		input.db,
		input.orgId,
		input.credentialId,
	)
	if (!credential?.live) {
		throw new McpCallerError('No credential with that id in this org.')
	}
	const touchesProviderOrInject =
		input.update.provider !== undefined || input.update.inject !== undefined
	const touchesPlacement = input.update.placement !== undefined
	if (credential.kind === 'vault') {
		if (touchesProviderOrInject) {
			throw new McpCallerError(
				'A vault binding takes its inject from each reference; it has no provider or inject to set. Only placement may change.',
			)
		}
		if (!touchesPlacement) {
			throw new McpCallerError(
				'A vault binding takes its inject from each reference; it has no provider or inject to set.',
			)
		}
	}
	if (credential.kind === 'mcp-server' && touchesPlacement) {
		throw new McpCallerError(
			'MCP servers have no placeholder fill placement; only provider can change.',
		)
	}
	const before = await readFields(input.db, credential)
	const provider =
		input.update.provider === undefined
			? before.provider
			: input.update.provider
	const inject = input.update.inject ?? before.inject
	const placement =
		input.update.placement === undefined
			? before.placement
			: input.update.placement
	if (
		credential.kind !== 'secret' &&
		credential.kind !== 'vault' &&
		JSON.stringify(inject) !== JSON.stringify(defaultCredentialInject)
	) {
		throw new McpCallerError(
			'OAuth connections and MCP servers always send their token as `Authorization: Bearer {value}`; only provider can change.',
		)
	}
	if (before.storedKind) {
		assertInjectFitsKind({ kind: before.storedKind, inject })
	}
	const placementTable =
		placementFieldTables[credential.kind as keyof typeof placementFieldTables]
	const setsPlacement = placementTable !== undefined && touchesPlacement
	/** Only secret_entries stores placement_origin (owner edit marker). */
	const setsSecretPlacementOrigin =
		setsPlacement && credential.kind === 'secret'
	const sql = setsSecretPlacementOrigin
		? `UPDATE ${fieldTables[credential.kind]} SET provider = ?, inject_json = ?, placement_json = ?, placement_origin = ?
			WHERE id = ? AND deleted_at IS NULL`
		: setsPlacement
			? `UPDATE ${fieldTables[credential.kind]} SET provider = ?, inject_json = ?, placement_json = ?
			WHERE id = ? AND deleted_at IS NULL`
			: `UPDATE ${fieldTables[credential.kind]} SET provider = ?, inject_json = ?
			WHERE id = ? AND deleted_at IS NULL`
	const placementOrigin = input.placementOrigin ?? 'owner'
	const statement = setsSecretPlacementOrigin
		? input.db
				.prepare(sql)
				.bind(
					provider,
					JSON.stringify(inject),
					serializeCredentialFillPlacement(placement),
					placementOrigin,
					credential.id,
				)
		: setsPlacement
			? input.db
					.prepare(sql)
					.bind(
						provider,
						JSON.stringify(inject),
						serializeCredentialFillPlacement(placement),
						credential.id,
					)
			: input.db
					.prepare(sql)
					.bind(provider, JSON.stringify(inject), credential.id)
	const details: Record<string, unknown> = {
		credentialKind: credential.kind,
	}
	if (touchesProviderOrInject) {
		details.provider = { before: before.provider, after: provider }
		details.inject = { before: before.inject, after: inject }
	}
	if (setsPlacement) {
		details.placement = { before: before.placement, after: placement }
	}
	await runAppDbBatchWithOrgAudit({
		appDb: input.db,
		audit: input.audit,
		statements: [statement],
		event: {
			orgId: input.orgId,
			action: 'credential.fields_updated',
			resourceType: 'credential',
			resourceId: credential.id,
			details,
		},
	})
	return { credential, provider, inject, placement }
}

export async function readCredentialFields(input: {
	db: D1Database
	credential: OrgCredential
}): Promise<CredentialFields> {
	const { credential, provider, inject, placement } = await readFields(
		input.db,
		input.credential,
	)
	return { credential, provider, inject, placement }
}

export type StoredCredentialPlacement = {
	id: string
	kind: StoredCredentialKindValue
	allowedHosts: Array<string>
	loginExchange: z.infer<typeof loginExchangeSchema> | null
	provider: string | null
	inject: CredentialInject
	placement: CredentialFillPlacement | null
}

/**
 * The kind, hosts, login exchange, provider, inject, and fill placement of
 * `orgId`'s live user-scope secret `name`, never its value. Null when there
 * is no such secret.
 */
export async function readStoredCredentialPlacement(input: {
	db: D1Database
	orgId: OwnerId
	name: string
}): Promise<StoredCredentialPlacement | null> {
	const row = await input.db
		.prepare(
			`SELECT e.id AS id, e.kind AS kind, e.allowed_hosts AS allowed_hosts,
				e.config_json AS config_json, e.provider AS provider,
				e.inject_json AS inject_json, e.placement_json AS placement_json
			FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ? AND b.scope = 'user' AND b.binding_key = ''
				AND e.name = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL`,
		)
		.bind(input.orgId, input.name)
		.first<{
			id: string
			kind: string
			allowed_hosts: string
			config_json: string | null
			provider: string | null
			inject_json: string
			placement_json: string | null
		}>()
	if (!row) return null
	const hosts = z.array(z.string()).safeParse(JSON.parse(row.allowed_hosts))
	const exchange = row.config_json
		? loginExchangeSchema.safeParse(JSON.parse(row.config_json))
		: null
	return {
		id: row.id,
		kind: parseStoredKind(row.kind),
		allowedHosts: hosts.success ? hosts.data : [],
		loginExchange: exchange?.success ? exchange.data : null,
		provider: row.provider,
		inject: parseInject(row.inject_json),
		placement: readCredentialFillPlacement(row.placement_json),
	}
}
