import { assertBackupDay } from '@kody-internal/shared/backup-staging.ts'

import type { BackupRuntimeStep } from './backup-runtime.ts'
import { BackupError, errorCode, safeLog } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'
import { sealFullBackupDay, type SealDayResult } from './seal-full-backup.ts'
import type { WorkflowInstanceStatus } from './workflow-trigger.ts'

export type SealedDayResult = Extract<SealDayResult, { kind: 'sealed' }>

export type SealStatusView =
	| { kind: 'pending'; status: string }
	| { kind: 'sealed'; manifestKey: string; alreadySealed: boolean }
	| { kind: 'incomplete'; reason: string }
	| { kind: 'failed'; message: string }

type SealDayFn = (env: BackupEnvironment, day: string) => Promise<SealDayResult>

export const sealDayStepName = 'seal-full-backup-day'

/**
 * One step covers the copy. Fat days that exceed the step wall clock retry
 * the same callback; immutable copies already written are skipped by seal.
 * Incomplete days throw a non-retryable BackupError so the instance stays
 * errored until an operator starts it again.
 */
const sealDayStepConfig = {
	retries: { limit: 4, delay: '30 seconds' },
	timeout: '15 minutes',
} as const

const sealDayInstanceIdPattern = /^seal-day-(\d{4}-\d{2}-\d{2})$/

export function sealDayWorkflowInstanceId(day: string): string {
	return `seal-day-${day}`
}

export function dayFromSealWorkflowInstanceId(
	instanceId: string,
): string | null {
	return sealDayInstanceIdPattern.exec(instanceId)?.[1] ?? null
}

export async function completeSealDay(
	env: BackupEnvironment,
	day: string,
	seal: SealDayFn = sealFullBackupDay,
): Promise<SealedDayResult> {
	try {
		assertBackupDay(day)
	} catch {
		throw new BackupError('invalid-day', `invalid backup day: ${day}`)
	}
	const result = await seal(env, day)
	switch (result.kind) {
		case 'sealed':
			return result
		case 'incomplete':
			safeLog({
				event: 'ui-seal-day',
				status: 'failure',
				day: result.day,
				errorCode: result.reason,
			})
			throw new BackupError(
				result.reason,
				`Day ${result.day} is not ready to seal (${result.reason}).`,
			)
		default: {
			const exhaustive: never = result
			throw exhaustive
		}
	}
}

export async function runSealDay(
	env: BackupEnvironment,
	day: string,
	step: BackupRuntimeStep,
	seal?: SealDayFn,
): Promise<SealedDayResult> {
	return step.do(sealDayStepName, sealDayStepConfig, () =>
		seal === undefined
			? completeSealDay(env, day)
			: completeSealDay(env, day, seal),
	)
}

function sealIncompleteReason(message: string): string | null {
	if (!message.includes('is not ready to seal')) return null
	const code = errorCode(new Error(message))
	return code === 'unexpected-error' ? null : code
}

function readSealedDayOutput(output: unknown): SealedDayResult | null {
	if (output === null || typeof output !== 'object' || Array.isArray(output)) {
		return null
	}
	const record = output as Record<string, unknown>
	if (record.kind !== 'sealed') return null
	if (typeof record.day !== 'string') return null
	if (typeof record.manifestKey !== 'string') return null
	if (typeof record.alreadySealed !== 'boolean') return null
	return {
		kind: 'sealed',
		day: record.day,
		manifestKey: record.manifestKey,
		alreadySealed: record.alreadySealed,
	}
}

export function describeSealStatus(input: {
	status: WorkflowInstanceStatus
	error?: { message?: string }
	output?: unknown
}): SealStatusView {
	switch (input.status) {
		case 'complete': {
			const sealed = readSealedDayOutput(input.output)
			if (sealed === null) {
				return {
					kind: 'failed',
					message: 'Seal finished without a seal result.',
				}
			}
			return {
				kind: 'sealed',
				manifestKey: sealed.manifestKey,
				alreadySealed: sealed.alreadySealed,
			}
		}
		case 'errored': {
			const reason = sealIncompleteReason(input.error?.message ?? '')
			if (reason !== null) return { kind: 'incomplete', reason }
			return {
				kind: 'failed',
				message: input.error?.message ?? 'Seal workflow failed.',
			}
		}
		case 'terminated':
			return { kind: 'failed', message: 'Seal workflow was terminated.' }
		case 'queued':
		case 'running':
		case 'paused':
		case 'waiting':
		case 'waitingForPause':
		case 'rollingBack':
		case 'unknown':
			return { kind: 'pending', status: input.status }
		default: {
			const exhaustive: never = input.status
			throw exhaustive
		}
	}
}

export function sealStatusResponseStatus(view: SealStatusView): number {
	switch (view.kind) {
		case 'pending':
		case 'sealed':
			return 200
		case 'incomplete':
			return 409
		case 'failed':
			return 500
		default: {
			const exhaustive: never = view
			throw exhaustive
		}
	}
}
