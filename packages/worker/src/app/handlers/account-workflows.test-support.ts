import {
	readAccountWorkflowsSelectedWorkflowId,
	loadAccountWorkflowsData,
} from '#app/account-workflows-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { cancelAccountWorkflowRun } from './account-workflows.ts'
export * from './account-workflows.ts'
export function testAccountWorkflowsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return operationResult(
					await loadAccountWorkflowsData({
						env,
						selectedWorkflowId: readAccountWorkflowsSelectedWorkflowId(
							request.url,
						),
						user,
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

			const fields = body as Record<string, unknown>
			const context = {
				request,
				env,
				user,
				id: typeof fields.id === 'string' ? fields.id : '',
			}
			let result
			try {
				result =
					fields.action === 'cancel'
						? await cancelAccountWorkflowRun(context)
						: operationResult({ ok: false, error: 'Invalid action.' }, 400)
			} catch (error) {
				result = operationResult(
					{
						ok: false,
						error: error instanceof Error ? error.message : 'Unable to update.',
					},
					400,
				)
			}
			return operationResult(result.data, result.status)
		},
	}
}
