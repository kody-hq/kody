import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
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

/**
 * The provider serves `/.well-known/oauth-authorization-server`; add the
 * device endpoint and grant type to its JSON without changing anything else.
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
	const enriched = {
		...metadata,
		...deviceGrantDiscoveryFields(appOrigin),
		grant_types_supported: addDeviceGrantType(metadata.grant_types_supported),
	}
	return new Response(JSON.stringify(enriched), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}
