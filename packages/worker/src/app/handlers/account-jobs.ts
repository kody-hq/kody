import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { runJobNowViaManager } from '#worker/jobs/manager-client.ts'
import { updateJob } from '#worker/jobs/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

function buildCallerContext(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
}) {
	return createMcpCallerContext({
		baseUrl: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		source: { kind: 'session' },
		executionOrigin: 'interactive',
		user: input.user.mcpUser,
		orgBinding: {
			org: input.user.request.org,
			role: input.user.request.membership?.role ?? null,
		},
	})
}

export async function setAccountJobKillSwitch(input: {
	env: Env
	user: AuthenticatedUser
	id: string
	killSwitchEnabled: boolean
	request: Request
}) {
	const id = input.id.trim()
	if (!id) throw new Error('Job id is required.')
	const killSwitchEnabled = input.killSwitchEnabled
	if (typeof killSwitchEnabled !== 'boolean') {
		throw new Error('killSwitchEnabled must be a boolean.')
	}
	await updateJob({
		env: input.env,
		callerContext: buildCallerContext(input),
		body: { id, killSwitchEnabled },
	})
	return operationResult({ ok: true, jobId: id, killSwitchEnabled })
}

export async function runAccountJobNow(input: {
	env: Env
	user: AuthenticatedUser
	id: string
	request: Request
}) {
	const id = input.id.trim()
	if (!id) throw new Error('Job id is required.')
	const result = await runJobNowViaManager({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		jobId: id,
		callerContext: buildCallerContext(input),
	})
	return operationResult({
		ok: true,
		jobId: id,
		runNow: {
			ok: result.execution.ok,
			error: result.execution.ok ? null : result.execution.error,
			deletedAfterRun: result.deletedAfterRun,
		},
	})
}
