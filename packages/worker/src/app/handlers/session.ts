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

		const loaded = await loadSessionInfo(request, env)
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
