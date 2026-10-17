import { connectSecretsInput } from '../../../start/connect-input.ts'
import {
	loadAccountSecretsSelection,
	readAccountSecretsSelectedSecretId,
} from '#app/account-secrets-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	saveAccountSecret,
	deleteAccountSecret,
	approveAccountSecretAccess,
	rejectAccountSecretAccess,
	saveAccountOAuthApp,
	connectAccountOAuth,
	exchangeAccountOAuthToken,
} from './account-secrets.ts'
export * from './account-secrets.ts'

export function testAccountSecretsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const payload = await loadAccountSecretsSelection({
					...connectSecretsInput(new URL(request.url).search),
					selectedSecretId: readAccountSecretsSelectedSecretId(request.url),
					env,
					user,
				})
				return operationResult(payload)
			}

			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return operationResult(
					{ ok: false, error: 'Invalid request body.' },
					400,
				)
			}

			const context = {
				request,
				env,
				user,
				refresh: {
					...connectSecretsInput(new URL(request.url).search),
					selectedSecretId: readAccountSecretsSelectedSecretId(request.url),
				},
			}
			const values = body as Record<string, unknown>
			let result
			switch (values.action) {
				case 'approve':
					result = await approveAccountSecretAccess(context)
					break
				case 'reject':
					result = await rejectAccountSecretAccess(context)
					break
				case 'save':
					result = await saveAccountSecret({
						...context,
						fields: values as Parameters<typeof saveAccountSecret>[0]['fields'],
					})
					break
				case 'delete':
					result = await deleteAccountSecret({
						...context,
						fields: values as Parameters<
							typeof deleteAccountSecret
						>[0]['fields'],
					})
					break
				case 'save_oauth_app':
					result = await saveAccountOAuthApp({
						...context,
						fields: values as Parameters<
							typeof saveAccountOAuthApp
						>[0]['fields'],
					})
					break
				case 'connect_oauth':
					result = await connectAccountOAuth({
						...context,
						fields: values as Parameters<
							typeof connectAccountOAuth
						>[0]['fields'],
					})
					break
				case 'oauth_exchange':
					result = await exchangeAccountOAuthToken({
						...context,
						fields: values as Parameters<
							typeof exchangeAccountOAuthToken
						>[0]['fields'],
					})
					break
				default:
					return operationResult({ ok: false, error: 'Invalid action.' }, 400)
			}

			return operationResult(result.data, result.status)
		},
	}
}
