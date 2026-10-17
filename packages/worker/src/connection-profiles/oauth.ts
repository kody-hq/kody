import {
	getConnectionProfileNameValidationError,
	normalizeConnectionProfileName,
	readConnectionProfileNameFromUrl,
	stripConnectionProfileFromResourceUri,
} from '#universal/connection-profiles/names.ts'
import { connectionProfilesFlagKey } from '#universal/feature-flags/registry.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { ConnectionProfileAuthorizeError } from '#worker/connection-profiles/authorize-error.ts'
import { getConnectionProfileByName } from '#worker/connection-profiles/repo.ts'
import { mcpOAuthResourceUri } from '#worker/oauth-provider-options.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { type AuthRequest } from '@cloudflare/workers-oauth-provider'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Resolve the connection profile name for an authorize request, and normalize
 * `authRequest.resource` to the canonical `/mcp` audience (strip `?profile=`).
 */
export async function resolveAuthorizeConnectionProfile(input: {
	authorizeUrl?: URL
	env: Env
	request: Request
	authRequest: AuthRequest
	userId: string
}): Promise<string | null> {
	const fromAuthorizeUrl = readConnectionProfileNameFromUrl(
		input.authorizeUrl?.href ?? input.request.url,
	)
	let fromResource: string | null = null
	if (typeof input.authRequest.resource === 'string') {
		const stripped = stripConnectionProfileFromResourceUri(
			input.authRequest.resource,
		)
		fromResource = stripped.profileName
		const origin = getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		})
		const canonical = mcpOAuthResourceUri(origin)
		// Only rewrite when the path matched `/mcp` with an optional profile query.
		try {
			const resourceUrl = new URL(stripped.canonicalResource)
			const canonicalUrl = new URL(canonical)
			if (
				resourceUrl.origin === canonicalUrl.origin &&
				resourceUrl.pathname.replace(/\/$/, '') ===
					canonicalUrl.pathname.replace(/\/$/, '')
			) {
				input.authRequest.resource = canonical
			}
		} catch {
			// Leave resource unchanged when it is not a URL we can normalize.
		}
	}

	if (
		fromAuthorizeUrl &&
		fromResource &&
		normalizeConnectionProfileName(fromAuthorizeUrl) !==
			normalizeConnectionProfileName(fromResource)
	) {
		throw new ConnectionProfileAuthorizeError(
			'Connection profile on the authorize URL and OAuth resource do not match.',
		)
	}

	const candidate = fromAuthorizeUrl ?? fromResource
	if (!candidate) return null

	const name = normalizeConnectionProfileName(candidate)
	if (getConnectionProfileNameValidationError(name)) {
		throw new ConnectionProfileAuthorizeError(
			`Invalid connection profile name "${candidate}".`,
		)
	}

	const enabled = await isFeatureEnabled(
		input.env.APP_DB,
		connectionProfilesFlagKey,
		await resolveDbUserId(input.env.APP_DB, input.userId),
	)
	// Non-experimenters: ignore ?profile= and keep today's unlimited connection.
	if (!enabled) return null

	const profile = await getConnectionProfileByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (!profile) {
		// Named profile that does not exist must not mint an unlimited grant.
		throw new ConnectionProfileAuthorizeError(
			`Connection profile "${name}" was not found.`,
		)
	}
	return profile.name
}

async function resolveDbUserId(db: D1Database, stableUserId: string) {
	const row = await db
		.prepare(
			`SELECT id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{ id: number }>()
	return row?.id ?? null
}

export function connectionProfileGrantFields(profileName: string | null): {
	props: { connectionProfileName?: string }
	metadata: { connectionProfileName?: string }
} {
	if (!profileName) return { props: {}, metadata: {} }
	return {
		props: { connectionProfileName: profileName },
		metadata: { connectionProfileName: profileName },
	}
}

export function readConnectionProfileNameFromGrantProps(
	props: unknown,
): string | null {
	if (!props || typeof props !== 'object') return null
	const value = (props as { connectionProfileName?: unknown })
		.connectionProfileName
	if (typeof value !== 'string') return null
	const name = normalizeConnectionProfileName(value)
	return name.length > 0 ? name : null
}

export function readConnectionProfileNameFromGrantMetadata(
	metadata: unknown,
): string | null {
	if (!metadata || typeof metadata !== 'object') return null
	const value = (metadata as { connectionProfileName?: unknown })
		.connectionProfileName
	if (typeof value !== 'string') return null
	const name = normalizeConnectionProfileName(value)
	return name.length > 0 ? name : null
}
