import { assertBackupDay } from '@kody-internal/shared/backup-staging.ts'

import {
	accessForbiddenResponse,
	assertSameOriginMutation,
	verifyAccessJwt,
} from './access-auth.ts'
import {
	BackupError,
	backupPayload,
	restExportSourceDatabases,
	errorCode,
	isBackupEnabled,
	safeLog,
	utcDay,
	workflowInstanceId,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import {
	htmlResponse,
	renderDashboard,
	renderDrillReport,
	renderEnqueueResult,
	renderMessagePage,
	renderRestoreAlreadyStartedPage,
	renderRestorePreparePage,
	renderRestoreStatusPage,
	renderSealStatusPage,
} from './control-plane-ui.ts'
import {
	restoreWorkflowInstanceId,
	validateSealedDayForRestore,
} from './production-restore.ts'
import {
	issueRestoreConfirmToken,
	verifyRestoreConfirmToken,
} from './restore-confirm-token.ts'
import { runRestoreDrill } from './restore-drill.ts'
import {
	dayFromSealWorkflowInstanceId,
	describeSealStatus,
	sealDayWorkflowInstanceId,
	sealStatusResponseStatus,
} from './seal-day-run.ts'
import { handleDrOpsMaintenanceRequest } from './dr-ops-maintenance.ts'
import { enqueueBackup, enqueueWorkflow } from './workflow-trigger.ts'

async function readForm(request: Request): Promise<URLSearchParams> {
	const contentType = request.headers.get('content-type') ?? ''
	if (contentType.includes('application/x-www-form-urlencoded')) {
		return new URLSearchParams(await request.text())
	}
	if (contentType.includes('multipart/form-data')) {
		const form = await request.formData()
		const params = new URLSearchParams()
		for (const [key, value] of form.entries()) {
			if (typeof value === 'string') params.set(key, value)
		}
		return params
	}
	return new URLSearchParams(await request.text())
}

function seeOther(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: {
			location,
			'cache-control': 'no-store',
		},
	})
}

function requireDay(value: string | null): string {
	if (value === null || value.trim().length === 0) {
		throw new BackupError('invalid-day', 'day is required')
	}
	const day = value.trim()
	assertBackupDay(day)
	return day
}

async function handleAuthenticated(
	request: Request,
	env: BackupEnvironment,
): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname

	if (request.method === 'GET' && path === '/') {
		return htmlResponse(await renderDashboard(env))
	}

	if (request.method === 'GET' && path === '/seal-status') {
		const id = url.searchParams.get('id')
		if (!id) {
			return htmlResponse(
				renderMessagePage('Seal status', 'Missing workflow id.', {
					danger: true,
				}),
				400,
			)
		}
		const day = dayFromSealWorkflowInstanceId(id)
		if (day === null) {
			return htmlResponse(
				renderMessagePage('Seal status', 'Unknown seal workflow id.', {
					danger: true,
				}),
				400,
			)
		}
		try {
			const instance = await env.SEAL_WORKFLOW.get(id)
			const status = await instance.status()
			const view = describeSealStatus({
				status: status.status,
				error: status.error,
				output: status.output,
			})
			return htmlResponse(
				renderSealStatusPage({ day, instanceId: id, view }),
				sealStatusResponseStatus(view),
			)
		} catch (error) {
			return htmlResponse(
				renderMessagePage(
					'Seal status',
					`Unable to read workflow status: ${error instanceof Error ? error.message : 'unknown error'}`,
					{ danger: true },
				),
				404,
			)
		}
	}

	if (request.method === 'GET' && path === '/restore-status') {
		const id = url.searchParams.get('id')
		if (!id) {
			return htmlResponse(
				renderMessagePage('Restore status', 'Missing workflow id.', {
					danger: true,
				}),
				400,
			)
		}
		try {
			const instance = await env.RESTORE_WORKFLOW.get(id)
			const status = await instance.status()
			const output =
				'output' in status ? (status as { output?: unknown }).output : undefined
			return htmlResponse(
				renderRestoreStatusPage({
					instanceId: id,
					status: status.status,
					progress:
						output && typeof output === 'object' ? (output as never) : null,
				}),
			)
		} catch (error) {
			return htmlResponse(
				renderMessagePage(
					'Restore status',
					`Unable to read workflow status: ${error instanceof Error ? error.message : 'unknown error'}`,
					{ danger: true },
				),
				404,
			)
		}
	}

	if (request.method !== 'POST') {
		return htmlResponse(
			renderMessagePage('Not found', 'Unknown route.', { danger: true }),
			404,
		)
	}

	assertSameOriginMutation(request)
	const form = await readForm(request)

	switch (path) {
		case '/actions/run-backup': {
			if (!isBackupEnabled(env)) {
				throw new BackupError(
					'backup-disabled',
					'backups are disabled by enable gate',
				)
			}
			const scheduledAt = new Date()
			const sources = restExportSourceDatabases(env)
			const results: Array<string> = []
			for (const source of sources) {
				const payload = backupPayload(env, scheduledAt, source)
				const result = await enqueueBackup(
					env.BACKUP_WORKFLOW,
					source.id,
					payload,
				)
				safeLog({
					event: 'ui-run-backup',
					status: 'success',
					day: payload.day,
					instanceId: workflowInstanceId(source.id, payload.day),
					databaseId: source.id,
					databaseName: source.name,
				})
				results.push(`${source.name}: ${result}`)
			}
			return htmlResponse(
				renderEnqueueResult(utcDay(scheduledAt), results.join('; ')),
			)
		}
		case '/actions/seal-day': {
			const day = requireDay(form.get('day'))
			const instanceId = sealDayWorkflowInstanceId(day)
			await enqueueWorkflow(env.SEAL_WORKFLOW, instanceId, { day })
			safeLog({
				event: 'ui-seal-day',
				status: 'success',
				day,
				instanceId,
			})
			const location = new URL('/seal-status', request.url)
			location.searchParams.set('id', instanceId)
			return seeOther(location.toString())
		}
		case '/actions/run-drill': {
			const day = requireDay(form.get('day'))
			const report = await runRestoreDrill(env, day, {
				database: form.get('database') ?? undefined,
			})
			safeLog({
				event: 'ui-run-drill',
				status: report.errorCode === null ? 'success' : 'failure',
				day,
				errorCode: report.errorCode ?? undefined,
			})
			return htmlResponse(
				renderDrillReport(report),
				report.errorCode === null ? 200 : 500,
			)
		}
		case '/actions/restore/prepare': {
			const day = requireDay(form.get('day'))
			const validated = await validateSealedDayForRestore(env, day)
			const token = await issueRestoreConfirmToken(env, day)
			safeLog({
				event: 'ui-restore-prepare',
				status: 'success',
				day,
				manifestKey: validated.fullManifestKey,
			})
			return htmlResponse(
				renderRestorePreparePage({
					day,
					sourceDatabaseName: env.SOURCE_DATABASE_NAME,
					sqlObjectKey: validated.sqlObjectKey,
					sqlBytes: validated.sqlBytes,
					sqlSha256: validated.sqlSha256,
					token,
				}),
			)
		}
		case '/actions/restore/execute': {
			const day = requireDay(form.get('day'))
			const expiresAt = form.get('expiresAt') ?? ''
			const confirmToken = form.get('confirmToken') ?? ''
			const typedDatabaseName = form.get('typedDatabaseName') ?? ''
			await verifyRestoreConfirmToken(env, {
				day,
				expiresAt,
				token: confirmToken,
			})
			if (typedDatabaseName !== env.SOURCE_DATABASE_NAME) {
				throw new BackupError(
					'restore-name-mismatch',
					'typed database name does not match SOURCE_DATABASE_NAME',
				)
			}
			const instanceId = restoreWorkflowInstanceId(day, expiresAt)
			try {
				await env.RESTORE_WORKFLOW.create({
					id: instanceId,
					params: {
						day,
						requestedAt: new Date().toISOString(),
					},
				})
			} catch {
				let existing = false
				try {
					await env.RESTORE_WORKFLOW.get(instanceId)
					existing = true
				} catch {
					existing = false
				}
				if (existing) {
					safeLog({
						event: 'ui-restore-execute',
						status: 'failure',
						day,
						instanceId,
						errorCode: 'restore-already-started',
					})
					return htmlResponse(renderRestoreAlreadyStartedPage(instanceId), 409)
				}
				throw new BackupError(
					'restore-workflow-create-failed',
					'failed to start production restore workflow',
					true,
				)
			}
			safeLog({
				event: 'ui-restore-execute',
				status: 'success',
				day,
				instanceId,
			})
			return htmlResponse(
				renderRestoreStatusPage({
					instanceId,
					status: 'queued',
					progress: null,
				}),
			)
		}
		default:
			return htmlResponse(
				renderMessagePage('Not found', 'Unknown action.', { danger: true }),
				404,
			)
	}
}

export async function handleControlPlaneFetch(
	request: Request,
	env: BackupEnvironment,
	fetcher: typeof fetch = fetch,
): Promise<Response> {
	const drOpsResponse = await handleDrOpsMaintenanceRequest(request, env)
	if (drOpsResponse) return drOpsResponse

	try {
		await verifyAccessJwt(env, request, fetcher)
	} catch (error) {
		safeLog({
			event: 'ui-auth-rejected',
			status: 'failure',
			errorCode: errorCode(error),
		})
		return accessForbiddenResponse(error)
	}

	try {
		return await handleAuthenticated(request, env)
	} catch (error) {
		safeLog({
			event: 'ui-action-failure',
			status: 'failure',
			errorCode: errorCode(error),
		})
		if (error instanceof BackupError && error.code === 'csrf-rejected') {
			return accessForbiddenResponse(error)
		}
		return htmlResponse(
			renderMessagePage(
				'Action failed',
				error instanceof Error ? error.message : 'unexpected error',
				{
					danger: true,
					details: error instanceof BackupError ? error.code : undefined,
				},
			),
			error instanceof BackupError ? 400 : 500,
		)
	}
}
