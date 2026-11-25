import { jsonResponse } from '#worker/json-response.ts'
import {
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { loadSessionInfo } from '#app/session-info.ts'

export function createSessionHandler(env: Env) {
	return async ({ request }: { request: Request }) => {
		const { session, setCookie } = await readAuthSessionResult(request)
		if (!session) {
			return jsonResponse({ ok: false })
		}

		const loaded = await loadSessionInfo(
			request,
			env,
			sessionOrgPathname(request),
		)
		if (!loaded.session) {
			return jsonResponse(
				{ ok: false },
				{
					headers: {
						'Set-Cookie':
							loaded.setCookie ??
							(await destroyAuthCookie(isSecureRequest(request))),
					},
				},
			)
		}

		return jsonResponse(
			{
				ok: true,
				session: loaded.session,
			},
			setCookie || loaded.setCookie
				? {
						headers: {
							'Set-Cookie': (setCookie ?? loaded.setCookie) as string,
						},
					}
				: undefined,
		)
	}
}

/**
 * `?org=<slug>` evaluates feature flags with that org as the page org, the
 * same as a page under `/@<slug>`. The desktop shell uses it to check a
 * package owner's flags before installing that owner's app.
 */
function sessionOrgPathname(request: Request) {
	const org = new URL(request.url).searchParams.get('org')
	return org && /^[a-zA-Z0-9_-]+$/.test(org) ? `/@${org}` : undefined
}
