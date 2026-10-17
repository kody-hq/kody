import {
	readAccountJobsSelectedJobId,
	loadAccountJobsData,
} from '#app/account-jobs-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import { setAccountJobKillSwitch, runAccountJobNow } from './account-jobs.ts'
export * from './account-jobs.ts'
export function testAccountJobsApiHandler(env: Env) {
	return {
		async execute({ request }: { request: Request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return operationResult({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const serverTiming: Array<ServerTimingEntry> = []
				return operationResult(
					await loadAccountJobsData({
						env,
						selectedJobId: readAccountJobsSelectedJobId(request.url),
						user,
						serverTiming,
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
				if (
					fields.action === 'set_kill_switch' &&
					typeof fields.killSwitchEnabled !== 'boolean'
				)
					throw new Error('killSwitchEnabled must be a boolean.')
				result =
					fields.action === 'set_kill_switch'
						? await setAccountJobKillSwitch({
								...context,
								killSwitchEnabled: fields.killSwitchEnabled === true,
							})
						: fields.action === 'run_now'
							? await runAccountJobNow(context)
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
