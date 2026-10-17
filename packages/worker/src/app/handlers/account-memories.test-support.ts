import {
	loadAccountMemoriesData,
	readAccountMemoriesQuery,
	readAccountMemoriesIncludeDeleted,
	readAccountMemoriesSelectedMemoryId,
} from '#app/account-memories-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { deleteAccountMemoryRecord } from './account-memories.ts'
export * from './account-memories.ts'

export function testAccountMemoriesApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadAccountMemoriesData({
						env,
						user,
						query: readAccountMemoriesQuery(request.url),
						includeDeleted: readAccountMemoriesIncludeDeleted(request.url),
						selectedMemoryId: readAccountMemoriesSelectedMemoryId(request.url),
					}),
				)
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

			if (!('action' in body) || body.action !== 'delete')
				return operationResult({ ok: false, error: 'Invalid action.' }, 400)

			const result = await deleteAccountMemoryRecord({
				env,
				user,
				memoryId:
					'memoryId' in body && typeof body.memoryId === 'string'
						? body.memoryId
						: '',
				force:
					'force' in body && typeof body.force === 'boolean'
						? body.force
						: false,
			})
			return operationResult(result.data, result.status)
		},
	}
}
