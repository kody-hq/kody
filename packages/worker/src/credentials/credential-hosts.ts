/**
 * Reads and persists editable hosts for Keys and user-managed OAuth
 * connections. The website handler authorizes the write and validates input.
 */
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { credentialHostsLimitError } from '#universal/credential-host-input.ts'
import type { CredentialHostSettings } from '#universal/credentials-list.ts'
import {
	type OrgAuditWriter,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { bumpUsableCredentialsGeneration } from './credential-read-generation.ts'
import { getOrgCredential, type OrgCredential } from './credential-ids.ts'

function parseHostList(json: string | null | undefined) {
	try {
		const parsed: unknown = JSON.parse(json ?? '[]')
		return Array.isArray(parsed)
			? normalizeAllowedHosts(
					parsed.filter((value): value is string => typeof value === 'string'),
				)
			: []
	} catch {
		return []
	}
}

type IntegrationHostsRow = {
	required_hosts_json: string
	platform_app_slug: string | null
	api_base_url: string | null
	token_url: string | null
}

type HostSettingsRead =
	| {
			kind: 'integration'
			stored: Array<string>
			/** Refresh posts to the token host, so every write keeps it. */
			tokenHost: string | null
			settings: CredentialHostSettings
	  }
	| { kind: 'secret'; stored: Array<string>; settings: CredentialHostSettings }

async function readHostSettings(
	db: D1Database,
	orgId: string,
	credential: OrgCredential,
): Promise<HostSettingsRead | { refused: string }> {
	switch (credential.kind) {
		case 'integration': {
			const row = await db
				.prepare(
					`SELECT i.required_hosts_json AS required_hosts_json,
						i.platform_app_slug AS platform_app_slug,
						a.api_base_url AS api_base_url, a.token_url AS token_url
					FROM user_integrations i
					LEFT JOIN user_oauth_apps a
						ON a.user_id = COALESCE(i.app_owner_id, i.user_id) AND a.slug = i.app_slug AND a.deleted_at IS NULL
					WHERE i.id = ? AND i.user_id = ? AND i.deleted_at IS NULL`,
				)
				.bind(credential.id, orgId)
				.first<IntegrationHostsRow>()
			if (!row) return { refused: 'No credential with that id in this org.' }
			// Reconnecting a built-in app resets its hosts to the app's, so an
			// edit there would silently disappear.
			if (row.platform_app_slug !== null) {
				return {
					refused:
						'Kody sets the hosts of a connection to a built-in app. Ask support to add a host.',
				}
			}
			const apiHost = row.api_base_url ? safeParseHost(row.api_base_url) : null
			const tokenHost = row.token_url ? safeParseHost(row.token_url) : null
			const fixedHosts = normalizeAllowedHosts([
				...(apiHost ? [apiHost] : []),
				...(tokenHost ? [tokenHost] : []),
			])
			const stored = parseHostList(row.required_hosts_json)
			return {
				kind: 'integration',
				stored,
				tokenHost,
				settings: {
					hosts: stored.filter((host) => !fixedHosts.includes(host)),
					fixedHosts,
				},
			}
		}
		case 'secret': {
			const row = await db
				.prepare(
					`SELECT e.kind AS kind, e.allowed_hosts AS allowed_hosts
					FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
					WHERE e.id = ? AND b.user_id = ? AND b.scope IN ('user', 'package')
						AND e.deleted_at IS NULL AND b.deleted_at IS NULL`,
				)
				.bind(credential.id, orgId)
				.first<{ kind: string; allowed_hosts: string }>()
			if (!row) return { refused: 'No credential with that id in this org.' }
			if (row.kind !== 'secret') {
				return {
					refused:
						'URL, login, and signing credentials take their hosts with their value. Set them again from the credential creation page.',
				}
			}
			const stored = parseHostList(row.allowed_hosts)
			return {
				kind: 'secret',
				stored,
				settings: { hosts: stored, fixedHosts: [] },
			}
		}
		case 'mcp-server':
			return {
				refused: 'An MCP server connects only to its server URL.',
			}
		case 'vault':
			return {
				refused: 'A vault takes its hosts from each item it resolves.',
			}
		default: {
			const exhaustive: never = credential.kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

/**
 * The hosts the website can edit for `credential`, or null when its kind
 * takes hosts some other way (or it is gone).
 */
export async function readCredentialHostSettings(input: {
	db: D1Database
	orgId: string
	credential: OrgCredential
}): Promise<CredentialHostSettings | null> {
	const read = await readHostSettings(input.db, input.orgId, input.credential)
	return 'refused' in read ? null : read.settings
}

function sameHosts(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
	return (
		left.length === right.length &&
		left.every((host, index) => host === right[index])
	)
}

/**
 * Replaces editable hosts and audits changes. For OAuth, retain stored fixed
 * hosts and include the token host when writing. The caller authorizes the
 * edit and parses `hosts` with `parseCredentialHostsInput`.
 */
export async function updateCredentialHosts(input: {
	db: D1Database
	orgId: string
	credentialId: string
	hosts: Array<string>
	audit: OrgAuditWriter
}): Promise<CredentialHostSettings & { changed: boolean }> {
	const credential = await getOrgCredential(
		input.db,
		input.orgId,
		input.credentialId,
	)
	if (!credential?.live) {
		throw new McpCallerError('No credential with that id in this org.')
	}
	const read = await readHostSettings(input.db, input.orgId, credential)
	if ('refused' in read) throw new McpCallerError(read.refused)
	const editable = normalizeAllowedHosts(input.hosts).filter(
		(host) => !read.settings.fixedHosts.includes(host),
	)
	if (editable.length === 0 && read.settings.fixedHosts.length === 0) {
		throw new McpCallerError(
			'Keep at least one host. To stop using this credential, delete it instead.',
		)
	}
	const limitError = credentialHostsLimitError(
		editable.length,
		read.settings.hosts.length,
	)
	if (limitError) throw new McpCallerError(limitError)
	const settings = { hosts: editable, fixedHosts: read.settings.fixedHosts }
	if (sameHosts(editable, read.settings.hosts)) {
		return { ...settings, changed: false }
	}
	const after =
		read.kind === 'integration'
			? normalizeAllowedHosts([
					...editable,
					...read.stored.filter((host) =>
						read.settings.fixedHosts.includes(host),
					),
					...(read.tokenHost ? [read.tokenHost] : []),
				])
			: editable
	const now = new Date().toISOString()
	const statement =
		read.kind === 'integration'
			? input.db
					.prepare(
						`UPDATE user_integrations SET required_hosts_json = ?, updated_at = ?
						WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
					)
					.bind(JSON.stringify(after), now, credential.id, input.orgId)
			: input.db
					.prepare(
						`UPDATE secret_entries SET allowed_hosts = ?, updated_at = ?
						WHERE id = ? AND kind = 'secret' AND deleted_at IS NULL
							AND bucket_id IN (SELECT id FROM secret_buckets WHERE user_id = ?)`,
					)
					.bind(JSON.stringify(after), now, credential.id, input.orgId)
	const { changed } = await runAppDbBatchWithOrgAudit({
		appDb: input.db,
		audit: input.audit,
		statements: [statement],
		onlyIfChanged: true,
		event: {
			orgId: input.orgId,
			action: 'credential.hosts_updated',
			resourceType: 'credential',
			resourceId: credential.id,
			details: {
				credentialKind: credential.kind,
				name: credential.name,
				hosts: { before: read.stored, after },
			},
		},
	})
	if (!changed) {
		throw new McpCallerError('No credential with that id in this org.')
	}
	bumpUsableCredentialsGeneration(input.db)
	return { ...settings, changed: true }
}
