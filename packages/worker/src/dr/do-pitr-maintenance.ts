import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	type DurableObjectPitrRpc,
	pitrUnavailableCode,
} from '#worker/dr/do-pitr.ts'
import {
	handleSecretMaintenanceRequest,
	MaintenanceFailureError,
} from '#worker/maintenance-handler.ts'
import {
	mailboxDurableObjectName,
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
	userMeterDurableObjectName,
} from '#worker/user-scoped-durable-object-name.ts'

const doPitrKinds = [
	'mailbox',
	'run-log',
	'user-meter',
	'storage-runner',
] as const
const pitrWindowMs = 30 * 24 * 60 * 60 * 1000

type DoPitrKind = (typeof doPitrKinds)[number]

type DoPitrTarget = {
	kind: DoPitrKind
	userId: OwnerId
	storageId?: string
}

function requireExactNonEmptyString(value: unknown, field: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value !== value.trim()
	) {
		throw new Error(`${field} must be an exact non-empty string.`)
	}
	return value
}

function parseKind(value: unknown): DoPitrKind {
	if (
		typeof value !== 'string' ||
		!(doPitrKinds as ReadonlyArray<string>).includes(value)
	) {
		throw new Error(`kind must be one of: ${doPitrKinds.join(', ')}.`)
	}
	return value as DoPitrKind
}

function parseTarget(body: Record<string, unknown>): DoPitrTarget {
	const kind = parseKind(body['kind'])
	const userId = requireExactNonEmptyString(body['userId'], 'userId') as OwnerId
	if (kind === 'storage-runner') {
		return {
			kind,
			userId,
			storageId: requireExactNonEmptyString(body['storageId'], 'storageId'),
		}
	}
	if (body['storageId'] !== undefined) {
		throw new Error('storageId is only valid for storage-runner.')
	}
	return { kind, userId }
}

function pitrRpcForTarget(
	env: Env,
	target: DoPitrTarget,
): DurableObjectPitrRpc {
	switch (target.kind) {
		case 'mailbox':
			return env.MAILBOX.get(
				env.MAILBOX.idFromName(mailboxDurableObjectName(target.userId)),
			) as unknown as DurableObjectPitrRpc
		case 'run-log':
			return env.RUN_LOG.get(
				env.RUN_LOG.idFromName(runLogDurableObjectName(target.userId)),
			) as unknown as DurableObjectPitrRpc
		case 'user-meter':
			return env.USER_METER.get(
				env.USER_METER.idFromName(userMeterDurableObjectName(target.userId)),
			) as unknown as DurableObjectPitrRpc
		case 'storage-runner': {
			if (!target.storageId) {
				throw new Error('storageId is required for storage-runner.')
			}
			return env.STORAGE_RUNNER.get(
				env.STORAGE_RUNNER.idFromName(
					storageRunnerDurableObjectName(target.userId, target.storageId),
				),
			) as unknown as DurableObjectPitrRpc
		}
		default: {
			const exhaustive: never = target.kind
			throw new Error(`Unhandled Durable Object kind: ${String(exhaustive)}`)
		}
	}
}

async function runDoPitrOperation(
	request: Request,
	env: Env,
	logger: Pick<Console, 'log'>,
) {
	let body: Record<string, unknown>
	try {
		const parsed = (await request.json()) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('body must be an object')
		}
		body = parsed as Record<string, unknown>
	} catch {
		throw new MaintenanceFailureError('Request body must be a JSON object', {
			code: 'invalid-request',
		})
	}

	try {
		const target = parseTarget(body)
		const rpc = pitrRpcForTarget(env, target)
		const operation = body['operation']
		switch (operation) {
			case 'get-recovery-bookmark': {
				const timestampMs = body['timestampMs']
				if (
					typeof timestampMs !== 'number' ||
					!Number.isSafeInteger(timestampMs)
				) {
					throw new Error('timestampMs must be a safe integer.')
				}
				const now = Date.now()
				if (timestampMs > now || timestampMs < now - pitrWindowMs) {
					throw new Error(
						'timestampMs must be within the previous 30 days and not in the future.',
					)
				}
				const result = await rpc.getRecoveryBookmark({ timestampMs })
				return { operation, ...target, ...result }
			}
			case 'restore-to-bookmark': {
				const bookmark = requireExactNonEmptyString(
					body['bookmark'],
					'bookmark',
				)
				const result = await rpc.restoreToBookmark({ bookmark })
				const operationId = crypto.randomUUID()
				logger.log(
					JSON.stringify({
						event: 'do-pitr-operator-restore',
						operationId,
						...target,
						targetBookmark: bookmark,
						undoBookmark: result.undoBookmark,
					}),
				)
				return { operation, operationId, ...target, ...result }
			}
			default:
				throw new Error(
					'operation must be get-recovery-bookmark or restore-to-bookmark.',
				)
		}
	} catch (error) {
		const message = getErrorMessage(error)
		if (message.includes(pitrUnavailableCode)) {
			throw new MaintenanceFailureError(message, {
				code: pitrUnavailableCode,
			})
		}
		throw new MaintenanceFailureError(message, { code: 'invalid-request' })
	}
}

export async function handleDoPitrRequest(
	request: Request,
	env: Env,
	logger: Pick<Console, 'log'> = console,
): Promise<Response> {
	if (request.method === 'POST' && env.SENTRY_ENVIRONMENT !== 'production') {
		return new Response('Forbidden', { status: 403 })
	}
	return await handleSecretMaintenanceRequest({
		request,
		secret: env.DR_RESTORE_SECRET,
		notConfiguredMessage: 'Durable Object PITR is not configured',
		run: async () => await runDoPitrOperation(request, env, logger),
	})
}
