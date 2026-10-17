import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { loadFittedMcpServerLogo } from '#worker/mcp-client/mcp-server-logo.ts'
import { getMcpServerSettingById } from '#worker/mcp-client/settings-service.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { orgSlugFromOrgOwnedPath } from '#universal/org-pages.ts'

/**
 * Logo URLs stay on `/account/mcp-servers/logos/…` (no org in the path), but
 * the MCP servers page is org-bound. Prefer the org named by a same-origin
 * Referer so team-org pages load logos stored on that org.
 */
async function ownerIdForMcpServerLogo(input: {
	env: Env
	user: AuthenticatedAppUser
	request: Request
}): Promise<OwnerId> {
	const referer = input.request.headers.get('referer')
	if (referer) {
		try {
			const refererUrl = new URL(referer)
			const requestOrigin = new URL(input.request.url).origin
			if (refererUrl.origin === requestOrigin) {
				const slug = orgSlugFromOrgOwnedPath(refererUrl.pathname)
				if (slug) {
					const binding = await loadOrgBindingForSlug(
						input.env.APP_DB,
						input.user.mcpUser.userId,
						slug,
					)
					if (binding) return binding.org.id
				}
			}
		} catch {
			// Fall through to the request org.
		}
	}
	return ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
}

/**
 * Serving route for user-added MCP server favicons. Requires a signed-in
 * session and resolves the server in the page's org (Referer) or the bound
 * request org so a team-org page does not 404 logos stored on that org.
 */
export function createMcpServerLogoHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { serverId: string }
	}) => {
		const user = await readAuthenticatedAppUser(request, env)
		if (!user) {
			return new Response('Not found', { status: 404 })
		}
		const userId = await ownerIdForMcpServerLogo({ env, user, request })
		const server = await getMcpServerSettingById({
			env,
			userId,
			id: params.serverId,
		})
		if (!server?.logoKey) {
			return new Response('Not found', { status: 404 })
		}
		const logo = await loadFittedMcpServerLogo({
			db: env.APP_DB,
			env,
			userId,
			serverId: server.id,
			logoKey: server.logoKey,
			logoContentType: server.logoContentType,
			logoSource: server.logoSource,
			faviconSourceHost: server.faviconSourceHost,
		})
		if (!logo) {
			return new Response('Not found', { status: 404 })
		}
		return new Response(logo.body, {
			headers: {
				'Cache-Control': logo.cacheControl,
				'Content-Length': String(logo.size),
				'Content-Type': logo.contentType,
				ETag: logo.httpEtag,
				'X-Content-Type-Options': 'nosniff',
			},
		})
	}
}
