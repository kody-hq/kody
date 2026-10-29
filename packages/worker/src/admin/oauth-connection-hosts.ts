/**
 * Which hosts each of an org's OAuth connections may be sent to, for support
 * checks. Metadata only: never a token, client id, or any other value.
 */
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import {
	type AdminOrgTarget,
	resolveAdminOrgTarget,
} from './org-limit-overrides.ts'

export const adminOauthConnectionHostsMax = 200

type ConnectionRow = {
	id: string | null
	name: string
	provider: string | null
	lane: 'user' | 'platform'
	token_url: string | null
	api_base_url: string | null
	required_hosts_json: string
	app_hosts_json: string | null
	connected: number
	connected_at: string | null
	auth_failed_at: string | null
	updated_at: string
}

function parseHosts(json: string | null) {
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

export async function loadAdminOauthConnectionHosts(input: {
	db: D1Database
	target: AdminOrgTarget
	provider?: string
}) {
	const org = await resolveAdminOrgTarget(input.db, input.target)
	const provider = input.provider?.trim().toLowerCase() || null
	const result = await input.db
		.prepare(
			`SELECT i.id AS id, i.name AS name,
				COALESCE(a.provider, p.provider, i.provider) AS provider,
				CASE WHEN i.platform_app_slug IS NULL THEN 'user' ELSE 'platform' END AS lane,
				COALESCE(a.token_url, p.token_url) AS token_url,
				COALESCE(a.api_base_url, p.api_base_url) AS api_base_url,
				i.required_hosts_json AS required_hosts_json,
				p.required_hosts_json AS app_hosts_json,
				(i.access_token_encrypted IS NOT NULL) AS connected,
				i.connected_at AS connected_at,
				i.auth_failed_at AS auth_failed_at,
				i.updated_at AS updated_at
			FROM user_integrations i
			LEFT JOIN user_oauth_apps a
				ON a.user_id = COALESCE(i.app_owner_id, i.user_id) AND a.slug = i.app_slug AND a.deleted_at IS NULL
			LEFT JOIN platform_oauth_apps p ON p.slug = i.platform_app_slug
			WHERE i.user_id = ? AND i.deleted_at IS NULL
				AND (? IS NULL
					OR lower(COALESCE(a.provider, p.provider, i.provider, '')) = ?
					OR lower(i.name) = ?)
			ORDER BY i.name
			LIMIT ?`,
		)
		.bind(
			org.id,
			provider,
			provider,
			provider,
			adminOauthConnectionHostsMax + 1,
		)
		.all<ConnectionRow>()
	const rows = result.results ?? []
	return {
		org: { id: org.id, slug: org.slug },
		connections: rows.slice(0, adminOauthConnectionHostsMax).map((row) => ({
			credentialId: row.id,
			name: row.name,
			provider: row.provider,
			lane: row.lane,
			tokenHost: row.token_url ? safeParseHost(row.token_url) : null,
			apiBaseHost: row.api_base_url ? safeParseHost(row.api_base_url) : null,
			hosts: parseHosts(row.required_hosts_json),
			appHosts: parseHosts(row.app_hosts_json),
			connected: Boolean(row.connected),
			connectedAt: row.connected_at,
			authFailedAt: row.auth_failed_at,
			updatedAt: row.updated_at,
		})),
		truncated: rows.length > adminOauthConnectionHostsMax,
	}
}
