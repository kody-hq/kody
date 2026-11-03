import { assertBackupDay } from '@kody-internal/shared/backup-staging.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'

import { BackupError, safeLog } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import {
	dayFromSealWorkflowInstanceId,
	describeSealStatus,
	sealDayWorkflowInstanceId,
	sealStatusResponseStatus,
} from './seal-day-run.ts'
import { enqueueWorkflow } from './workflow-trigger.ts'

const drSealPath = '/__maintenance/dr-seal'
const drSealStatusPath = '/__maintenance/seal-status'

function readBearerToken(request: Request) {
	const auth = request.headers.get('Authorization')?.trim()
	return auth?.startsWith('Bearer ')
		? auth.slice('Bearer '.length).trim()
		: null
}

function unauthorizedResponse() {
	return new Response('Unauthorized', { status: 401 })
}

function notConfiguredResponse() {
	return new Response('DR ops maintenance is not configured', { status: 503 })
}

function isDrOpsMaintenancePath(pathname: string) {
	return pathname === drSealPath || pathname === drSealStatusPath
}

async function assertDrOpsBearer(request: Request, env: BackupEnvironment) {
	const secret = env.DR_OPS_SECRET?.trim()
	if (!secret) {
		return notConfiguredResponse()
	}
	const bearer = readBearerToken(request)
	if (bearer === null || !(await timingSafeEqualString(bearer, secret))) {
		return unauthorizedResponse()
	}
	return null
}

function parseSealDayBody(value: unknown): string {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new BackupError('invalid-day', 'Request body requires day: string')
	}
	const day = (value as Record<string, unknown>).day
	if (typeof day !== 'string') {
		throw new BackupError('invalid-day', 'Request body requires day: string')
	}
	try {
		assertBackupDay(day.trim())
	} catch {
		throw new BackupError('invalid-day', 'day must be a UTC YYYY-MM-DD day')
	}
	return day.trim()
}

async function handleDrSealPost(
	request: Request,
	env: BackupEnvironment,
): Promise<Response> {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json(
			{ ok: false, error: 'Request body must be JSON' },
			{ status: 400 },
		)
	}
	let day: string
	try {
		day = parseSealDayBody(body)
	} catch (error) {
		const message = error instanceof BackupError ? error.message : 'invalid day'
		return Response.json({ ok: false, error: message }, { status: 400 })
	}
	const instanceId = sealDayWorkflowInstanceId(day)
	await enqueueWorkflow(env.SEAL_WORKFLOW, instanceId, { day })
	safeLog({
		event: 'ui-seal-day',
		status: 'success',
		day,
		instanceId,
	})
	return Response.json({ ok: true, day, instanceId })
}

async function handleDrSealStatusGet(
	request: Request,
	env: BackupEnvironment,
): Promise<Response> {
	const url = new URL(request.url)
	const id = url.searchParams.get('id')
	if (!id) {
		return Response.json(
			{ ok: false, error: 'Missing workflow id.' },
			{ status: 400 },
		)
	}
	const day = dayFromSealWorkflowInstanceId(id)
	if (day === null) {
		return Response.json(
			{ ok: false, error: 'Unknown seal workflow id.' },
			{ status: 400 },
		)
	}
	let instance: Awaited<ReturnType<BackupEnvironment['SEAL_WORKFLOW']['get']>>
	try {
		instance = await env.SEAL_WORKFLOW.get(id)
	} catch (error) {
		console.error(
			'dr_ops_seal_status_lookup_failed',
			JSON.stringify({
				id,
				error: error instanceof Error ? error.message : String(error),
			}),
		)
		return Response.json(
			{ ok: false, error: 'Seal workflow not found.' },
			{ status: 404 },
		)
	}
	try {
		const status = await instance.status()
		const view = describeSealStatus({
			status: status.status,
			error: status.error,
			output: status.output,
		})
		return Response.json(
			{ ok: true, id, day, view },
			{ status: sealStatusResponseStatus(view) },
		)
	} catch (error) {
		console.error(
			'dr_ops_seal_status_read_failed',
			JSON.stringify({
				id,
				error: error instanceof Error ? error.message : String(error),
			}),
		)
		return Response.json(
			{ ok: false, error: 'Unable to read seal workflow status.' },
			{ status: 503 },
		)
	}
}

/**
 * Agent-facing seal enqueue/status on the DR control plane. Authenticated with
 * `DR_OPS_SECRET` only — not `DR_RESTORE_SECRET` — so ops credentials cannot
 * reach production restore, purge, or delete paths.
 */
export async function handleDrOpsMaintenanceRequest(
	request: Request,
	env: BackupEnvironment,
): Promise<Response | null> {
	const url = new URL(request.url)
	if (!isDrOpsMaintenancePath(url.pathname)) {
		return null
	}

	const authFailure = await assertDrOpsBearer(request, env)
	if (authFailure) return authFailure

	if (url.pathname === drSealPath) {
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 })
		}
		return handleDrSealPost(request, env)
	}

	if (request.method !== 'GET') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	return handleDrSealStatusGet(request, env)
}
