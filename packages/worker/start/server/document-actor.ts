import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { loadResolvedRequestAuth } from '../../src/app/request-auth-cache.ts'
import { setAuthSessionSecret } from '../../src/app/auth-session.ts'
import { getEnv } from '../../src/app/env.ts'
import {
	documentActorHeader,
	verifyDocumentActor,
} from '../session-identity.ts'

export function markRpcResponsePrivate() {
	setResponseHeader('Cache-Control', 'private, no-store')
}

export async function verifyBrowserDocument() {
	const request = getRequest()
	if (!request.headers.has(documentActorHeader)) return
	setAuthSessionSecret(getEnv(env).COOKIE_SECRET)
	const { user } = await loadResolvedRequestAuth(request, env)
	verifyDocumentActor({
		headers: request.headers,
		requestUrl: request.url,
		actor:
			user && !user.accountSuspended && !user.accountDeleting
				? user.mcpUser.userId
				: null,
	})
}
