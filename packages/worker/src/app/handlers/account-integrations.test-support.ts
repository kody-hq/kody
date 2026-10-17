import {
	rotateOauthAppCredentialsSchema,
	disconnectConnectionSchema,
	deleteOauthAppSchema,
	setUsageSchema,
	approvePackageSchema,
} from '#universal/integration-mutations.ts'
import {
	hasStoredConnectClientSecret,
	loadAccountIntegrationByName,
	loadAccountIntegrationsData,
	loadAccountOauthAppBySlug,
	loadExistingConnectionSummary,
	readConnectOauthLookupOptions,
} from '#app/account-integrations-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadConnectOauthChooser } from '#app/connect-oauth-chooser.ts'
import { operationResult } from '#app/operation-result.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { waitUntil } from 'cloudflare:workers'
import {
	rotateAccountOauthAppCredentials,
	disconnectAccountIntegration,
	deleteAccountOauthApp,
	setAccountIntegrationUsage,
	approveAccountIntegrationPackage,
} from './account-integrations.ts'
export * from './account-integrations.ts'
export function testAccountIntegrationsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const searchParams = new URL(request.url).searchParams
				if (searchParams.get('connectChooser') === '1') {
					return operationResult({
						ok: true,
						chooser: await loadConnectOauthChooser({
							env,
							userId: ownerIdFromCaller({
								request: user.request,
								user: user.mcpUser,
							}),
						}),
					})
				}
				const name = searchParams.get('name')?.trim()
				const approvalPackageId = searchParams.get('package_id')?.trim()
				if (name && !approvalPackageId) {
					// `app=<slug>` reuses a saved bring-your-own app under `name`.
					// `platform=` is ignored: built-in connect is retired.
					const integration = await loadAccountIntegrationByName(
						env,
						user,
						name,
						readConnectOauthLookupOptions(searchParams),
					)
					const [existingConnection, hasStoredClientSecret] = await Promise.all(
						[
							loadExistingConnectionSummary(env, user, name),
							hasStoredConnectClientSecret(env, user, name, integration),
						],
					)
					return operationResult({
						ok: true,
						integration,
						builtInAvailable: false,
						existingConnection,
						hasStoredClientSecret,
					})
				}
				const appSlug = searchParams.get('appSlug')?.trim()
				if (appSlug) {
					const app = await loadAccountOauthAppBySlug(env, user, appSlug)
					if (!app) {
						return operationResult(
							{ ok: false, error: 'OAuth app not found.' },
							404,
						)
					}
					return operationResult({ ok: true, app })
				}
				return operationResult(
					await loadAccountIntegrationsData(env, user, {
						waitUntil,
						approvalName:
							new URL(request.url).searchParams.get('name') ?? undefined,
						approvalPackageId:
							new URL(request.url).searchParams.get('package_id') ?? undefined,
					}),
				)
			}

			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object')
				return operationResult(
					{ ok: false, error: 'Invalid request body.' },
					400,
				)
			const { action, ...fields } = body as Record<string, unknown>
			const context = { env, user }
			let result
			switch (action) {
				case 'rotate_oauth_app_credentials': {
					const parsed = rotateOauthAppCredentialsSchema.safeParse(fields)
					if (!parsed.success)
						return operationResult(
							{ ok: false, error: 'Invalid request body.' },
							400,
						)
					result = await rotateAccountOauthAppCredentials({
						...context,
						...parsed.data,
					})
					break
				}
				case 'disconnect_connection': {
					const parsed = disconnectConnectionSchema.safeParse(fields)
					if (!parsed.success)
						return operationResult(
							{ ok: false, error: 'Invalid request body.' },
							400,
						)
					result = await disconnectAccountIntegration({
						...context,
						name: parsed.data.name,
					})
					break
				}
				case 'delete_oauth_app': {
					const parsed = deleteOauthAppSchema.safeParse(fields)
					if (!parsed.success)
						return operationResult(
							{ ok: false, error: 'Invalid request body.' },
							400,
						)
					result = await deleteAccountOauthApp({
						...context,
						appSlug: parsed.data.appSlug,
					})
					break
				}
				case 'set_usage': {
					const parsed = setUsageSchema.safeParse(fields)
					if (!parsed.success)
						return operationResult(
							{ ok: false, error: 'Invalid request body.' },
							400,
						)
					result = await setAccountIntegrationUsage({
						...context,
						...parsed.data,
					})
					break
				}
				case 'approve_package': {
					const parsed = approvePackageSchema.safeParse(fields)
					if (!parsed.success)
						return operationResult(
							{ ok: false, error: 'Invalid request body.' },
							400,
						)
					result = await approveAccountIntegrationPackage({
						...context,
						...parsed.data,
					})
					break
				}
				default:
					return operationResult(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
			}

			return operationResult(result.data, result.status)
		},
	}
}
