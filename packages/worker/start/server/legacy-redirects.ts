import { resolveLegacyGuidesLocation } from '#app/handlers/legacy-guides-redirect.ts'
import { resolveLegacyOrgConnectionsLocation } from '#app/handlers/legacy-org-connections-redirect.ts'
export function guidesRedirect({ request }: { request: Request }) {
	return new Response(null, {
		status: 308,
		headers: {
			Location: resolveLegacyGuidesLocation(new URL(request.url)),
			'Cache-Control': 'public, max-age=3600',
		},
	})
}
export function connectionsRedirect({ request }: { request: Request }) {
	const location = resolveLegacyOrgConnectionsLocation(new URL(request.url))
	return new Response(null, {
		status: location ? 301 : 404,
		headers: location
			? { Location: location, 'Cache-Control': 'public, max-age=3600' }
			: {},
	})
}
