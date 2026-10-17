import { getGlobalStartContext } from '@tanstack/react-start'
import type {} from './request-context.ts'
import {
	createStartHandler,
	defaultStreamHandler,
	getResponseStatus,
} from '@tanstack/react-start/server'
import { secureNativeResponse } from '../src/app/native-response-envelope.ts'

const startHandler = createStartHandler(async (context) => {
	const nonce = getGlobalStartContext()?.nonce
	if (!nonce || context.router.options.ssr?.nonce !== nonce) {
		throw new Error('Document rendering requires its matching request nonce')
	}
	const status = getResponseStatus()
	const result = await defaultStreamHandler(context)
	const response = result instanceof Response ? result : result.response
	if (status === 200 || response.status !== 200) return result
	const withStatus = new Response(response.body, {
		status,
		headers: response.headers,
	})
	return result instanceof Response
		? withStatus
		: { ...result, response: withStatus }
})

export async function renderNativeDocument(
	request: Request,
	env: Env,
	documentFailure?: { status: 403 | 404 | 500 },
) {
	const nonce = crypto.randomUUID().replaceAll('-', '')
	const response = await renderStart()
	function renderStart() {
		return startHandler(request, {
			context: {
				nonce,
				env,
				documentFailure,
			},
		})
	}
	return secureNativeResponse(request, response, env, nonce, documentFailure)
}

export default { fetch: startHandler }
