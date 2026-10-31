import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { agentClaimGrantType } from '#worker/agent-registration/grant-type.ts'
import { deviceCodeGrantType } from './device-grant.ts'

/** RFC 8628 section 4 metadata for Kody's authorization server. */
export function deviceGrantDiscoveryFields(appOrigin: string) {
	return {
		device_authorization_endpoint: new URL(
			oauthPaths.deviceAuthorization,
			appOrigin,
		).href,
	}
}

export function addDeviceGrantType(grantTypes: unknown) {
	const list = Array.isArray(grantTypes)
		? grantTypes.filter((value): value is string => typeof value === 'string')
		: []
	return list.includes(deviceCodeGrantType)
		? list
		: [...list, deviceCodeGrantType]
}

/** auth.md `agent_auth` block (ADR 0091): `service_auth` registration only. */
export function agentAuthDiscoveryFields(appOrigin: string) {
	return {
		agent_auth: {
			skill: new URL('/auth.md', appOrigin).href,
			identity_endpoint: new URL(oauthPaths.agentIdentity, appOrigin).href,
			claim_endpoint: new URL(oauthPaths.agentIdentityClaim, appOrigin).href,
			identity_types_supported: ['service_auth'],
		},
	}
}

/**
 * The provider serves `/.well-known/oauth-authorization-server`; add the
 * device endpoint, the auth.md `agent_auth` block, and both grant types to its
 * JSON without changing anything else.
 */
export async function withDeviceGrantDiscovery(
	request: Request,
	env: Env,
	response: Response,
) {
	if (!response.ok) return response
	const contentType = response.headers.get('Content-Type') ?? ''
	if (!contentType.includes('application/json')) return response
	const metadata = (await response.json()) as Record<string, unknown>
	const appOrigin = getAppBaseUrl({ env, requestUrl: request.url })
	const grantTypes = addDeviceGrantType(metadata.grant_types_supported)
	const enriched = {
		...metadata,
		...deviceGrantDiscoveryFields(appOrigin),
		...agentAuthDiscoveryFields(appOrigin),
		grant_types_supported: grantTypes.includes(agentClaimGrantType)
			? grantTypes
			: [...grantTypes, agentClaimGrantType],
	}
	return new Response(JSON.stringify(enriched), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}
