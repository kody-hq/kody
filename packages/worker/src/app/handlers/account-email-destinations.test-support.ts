import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	buildEmailDestinationsLoaderData,
	listEmailNotificationDestinations,
} from '#worker/email/destinations.ts'
import {
	addAccountEmailDestination,
	resendAccountEmailDestination,
	setDefaultAccountEmailDestination,
	removeAccountEmailDestination,
} from './account-email-destinations.ts'
export * from './account-email-destinations.ts'
export function testAccountEmailDestinationsHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const destinations = await listEmailNotificationDestinations({
					db: env.APP_DB,
					dbUserId: user.userId,
					accountEmail: user.email,
					accountEmailVerified: user.emailVerified,
				})
				return operationResult(buildEmailDestinationsLoaderData(destinations))
			}

			if (request.method !== 'POST') {
				return operationResult({ ok: false, error: 'Method not allowed.' }, 405)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return operationResult(
					{ ok: false, error: 'Invalid JSON payload.' },
					400,
				)
			}

			const input = body as {
				action?: unknown
				email?: unknown
				id?: unknown
			} | null
			if (
				!input ||
				typeof input !== 'object' ||
				!['add', 'resend', 'setDefault', 'remove'].includes(
					String(input.action),
				) ||
				(input.email !== undefined && typeof input.email !== 'string') ||
				(input.id !== undefined && typeof input.id !== 'string')
			)
				return operationResult(
					{ ok: false, error: 'Invalid request body.' },
					400,
				)
			const context = { request, env, user }
			const result =
				input.action === 'add'
					? await addAccountEmailDestination({
							...context,
							email: String(input.email ?? ''),
						})
					: input.action === 'resend'
						? await resendAccountEmailDestination({
								...context,
								destinationId: String(input.id ?? ''),
							})
						: input.action === 'setDefault'
							? await setDefaultAccountEmailDestination({
									...context,
									destinationId: String(input.id ?? ''),
								})
							: await removeAccountEmailDestination({
									...context,
									destinationId: String(input.id ?? ''),
								})

			return operationResult(result.data, {
				status: result.status,
				headers: result.headers,
			})
		},
	}
}
