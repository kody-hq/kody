import {
	loadAccountMemoriesExport,
	readAccountMemoriesIncludeDeleted,
} from '#app/account-memories-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { orgSectionDenial } from '#app/org-request-binding.ts'
import { readOrgSlugFromUrl } from '#universal/org-binding/url.ts'
import { buildMemoriesExportFilename } from '#universal/memory-export.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'

/** Download scope is explicit, never inferred from Referer or a page match. */
export function createAccountMemoriesExportHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		// Authenticate the original session against the personal scope. This boundary
		// validates its explicit download scope below, independent of URL routing.
		const user = await readAuthenticatedAppUser(request, env, {
			resourceRequest: new Request(new URL('/', request.url)),
		})
		if (!user) return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
		if (request.method !== 'GET' && request.method !== 'HEAD')
			return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
		const url = new URL(request.url)
		let scopedUser = user
		if (url.searchParams.has('org')) {
			const slug = readOrgSlugFromUrl(url)
			const binding = slug
				? await loadOrgBindingForSlug(env.APP_DB, user.mcpUser.userId, slug)
				: null
			if (!binding || orgSectionDenial(binding, 'memories')) {
				return jsonResponse(
					{ ok: false, error: 'Organization unavailable.' },
					404,
				)
			}
			scopedUser = {
				...user,
				request: deriveRequestContext({
					user: user.mcpUser,
					source: { kind: 'session' },
					orgBinding: binding,
				}),
			}
		}
		const payload = await loadAccountMemoriesExport({
			env,
			user: scopedUser,
			includeDeleted: readAccountMemoriesIncludeDeleted(request.url),
		})
		return new Response(
			request.method === 'HEAD' ? null : JSON.stringify(payload, null, 2),
			{
				status: 200,
				headers: {
					'Cache-Control': 'no-store',
					'Content-Disposition': `attachment; filename="${buildMemoriesExportFilename()}"`,
					'Content-Type': 'application/json; charset=utf-8',
				},
			},
		)
	}
}
