/**
 * Write-once activation timestamps on `users` for the post-auth factory funnel.
 * Prefer these first-seen columns over reconstructing from usage/MCP warehouses.
 * Never throws: activation metering must not break MCP, execute, or package paths.
 */

import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import type { OnboardingFunnelStage } from '#universal/onboarding-funnel-point.ts'
import type { OnboardingFunnelEnv } from './onboarding-funnel-event.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

function nowIso(at?: string) {
	return at ?? new Date().toISOString()
}

/**
 * Stamp first successful MCP/agent connection and optional client name.
 * Also refreshes last_active_at when the calendar day advances.
 */
export async function stampFirstMcpConnected(
	db: D1Database,
	input: {
		stableUserId: string
		clientName?: string | null
		at?: string
	},
): Promise<void> {
	try {
		const at = nowIso(input.at)
		const clientName =
			typeof input.clientName === 'string' && input.clientName.trim()
				? input.clientName.trim().slice(0, 200)
				: null
		await db
			.prepare(
				`UPDATE users
				SET first_mcp_connected_at = COALESCE(first_mcp_connected_at, ?1),
					mcp_client_name = CASE
						WHEN mcp_client_name IS NULL AND ?2 IS NOT NULL THEN ?2
						ELSE mcp_client_name
					END,
					last_active_at = CASE
						WHEN last_active_at IS NULL THEN ?1
						WHEN date(last_active_at) < date(?1) THEN ?1
						ELSE last_active_at
					END,
					updated_at = CASE
						WHEN first_mcp_connected_at IS NULL
							OR (mcp_client_name IS NULL AND ?2 IS NOT NULL)
							OR last_active_at IS NULL
							OR date(last_active_at) < date(?1)
						THEN ?3
						ELSE updated_at
					END
				WHERE stable_user_id = ?4
					AND (
						first_mcp_connected_at IS NULL
						OR (mcp_client_name IS NULL AND ?2 IS NOT NULL)
						OR last_active_at IS NULL
						OR date(last_active_at) < date(?1)
					)${andLiveDeletedAtSql()}`,
			)
			.bind(at, clientName, utcSqliteTimestamp(), input.stableUserId)
			.run()
	} catch (error) {
		console.debug('activation-stamp-mcp-failed', error)
	}
}

export async function userHasFirstExecute(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	try {
		const row = await db
			.prepare(
				`SELECT first_execute_at
				 FROM users
				 WHERE stable_user_id = ?
				 ${andLiveDeletedAtSql()} LIMIT 1`,
			)
			.bind(userId)
			.first<{ first_execute_at: string | null }>()
		return Boolean(row?.first_execute_at)
	} catch {
		return false
	}
}

export async function userHasFirstSearch(
	db: D1Database,
	userId: string,
): Promise<boolean> {
	try {
		const row = await db
			.prepare(
				`SELECT first_search_at
				 FROM users
				 WHERE stable_user_id = ?
				 ${andLiveDeletedAtSql()} LIMIT 1`,
			)
			.bind(userId)
			.first<{ first_search_at: string | null }>()
		return Boolean(row?.first_search_at)
	} catch {
		return false
	}
}

const activationClaimColumns = [
	'first_execute_at',
	'first_search_at',
	'first_saved_package_at',
	'first_secret_at',
	'first_integration_at',
	'first_job_at',
] as const

type ActivationClaimColumn = (typeof activationClaimColumns)[number]

const activationClaimStage: Record<
	ActivationClaimColumn,
	OnboardingFunnelStage
> = {
	first_execute_at: 'first_execute',
	first_search_at: 'first_search',
	first_saved_package_at: 'first_package',
	first_secret_at: 'first_secret',
	first_integration_at: 'first_integration',
	first_job_at: 'first_job',
}

function activationColumnLiteral(column: ActivationClaimColumn) {
	switch (column) {
		case 'first_execute_at':
			return 'first_execute_at'
		case 'first_search_at':
			return 'first_search_at'
		case 'first_saved_package_at':
			return 'first_saved_package_at'
		case 'first_secret_at':
			return 'first_secret_at'
		case 'first_integration_at':
			return 'first_integration_at'
		case 'first_job_at':
			return 'first_job_at'
		default: {
			const exhaustive: never = column
			throw new Error(`Unknown activation stamp: ${String(exhaustive)}`)
		}
	}
}

function activationClaimSql(column: ActivationClaimColumn) {
	const name = activationColumnLiteral(column)
	return `UPDATE users
		SET ${name} = ?1,
			last_active_at = CASE
				WHEN last_active_at IS NULL THEN ?1
				WHEN date(last_active_at) < date(?1) THEN ?1
				ELSE last_active_at
			END,
			updated_at = ?2
		WHERE stable_user_id = ?3
			AND ${name} IS NULL`
}

function recordClaimedFunnelStage(
	env: OnboardingFunnelEnv | null | undefined,
	stage: OnboardingFunnelStage,
	userId: string,
) {
	try {
		if (!env?.ONBOARDING_FUNNEL_EVENTS) return
		if (!/^[a-f0-9]{64}$/.test(userId)) return
		env.ONBOARDING_FUNNEL_EVENTS.writeDataPoint({
			indexes: [userId],
			blobs: [stage, '', '', ''],
			doubles: [1],
		})
	} catch (error) {
		console.warn('onboarding-funnel-event-failed', error)
	}
}

/**
 * Write-once claim. Returns true only when this call stored the timestamp.
 * Subsequent calls still refresh last_active_at. Never throws.
 */
async function claimActivationStamp(
	db: D1Database,
	input: {
		column: ActivationClaimColumn
		stableUserId: string
		at?: string
		debugLabel: string
		telemetry?: OnboardingFunnelEnv | null
	},
): Promise<boolean> {
	try {
		const at = nowIso(input.at)
		const result = await db
			.prepare(activationClaimSql(input.column))
			.bind(at, utcSqliteTimestamp(), input.stableUserId)
			.run()
		const first = (result.meta?.changes ?? 0) > 0
		if (!first) {
			await touchLastActiveAt(db, {
				stableUserId: input.stableUserId,
				at,
			})
			return false
		}
		recordClaimedFunnelStage(
			input.telemetry,
			activationClaimStage[input.column],
			input.stableUserId,
		)
		return true
	} catch (error) {
		console.debug(input.debugLabel, error)
		return false
	}
}

export async function stampFirstExecute(
	db: D1Database,
	input: { stableUserId: string; at?: string },
	telemetry?: OnboardingFunnelEnv | null,
): Promise<boolean> {
	return claimActivationStamp(db, {
		column: 'first_execute_at',
		stableUserId: input.stableUserId,
		at: input.at,
		debugLabel: 'activation-stamp-execute-failed',
		telemetry,
	})
}

export async function stampFirstSearch(
	db: D1Database,
	input: { stableUserId: string; at?: string },
	telemetry?: OnboardingFunnelEnv | null,
): Promise<boolean> {
	return claimActivationStamp(db, {
		column: 'first_search_at',
		stableUserId: input.stableUserId,
		at: input.at,
		debugLabel: 'activation-stamp-search-failed',
		telemetry,
	})
}

export async function stampFirstSavedPackage(
	db: D1Database,
	input: { stableUserId: string; at?: string },
	telemetry?: OnboardingFunnelEnv | null,
): Promise<boolean> {
	return claimActivationStamp(db, {
		column: 'first_saved_package_at',
		stableUserId: input.stableUserId,
		at: input.at,
		debugLabel: 'activation-stamp-saved-package-failed',
		telemetry,
	})
}

export async function stampFirstSecret(
	db: D1Database,
	input: { stableUserId: string; at?: string },
	telemetry?: OnboardingFunnelEnv | null,
): Promise<boolean> {
	return claimActivationStamp(db, {
		column: 'first_secret_at',
		stableUserId: input.stableUserId,
		at: input.at,
		debugLabel: 'activation-stamp-secret-failed',
		telemetry,
	})
}

export async function stampFirstIntegration(
	db: D1Database,
	input: { stableUserId: string; at?: string },
	telemetry?: OnboardingFunnelEnv | null,
): Promise<boolean> {
	return claimActivationStamp(db, {
		column: 'first_integration_at',
		stableUserId: input.stableUserId,
		at: input.at,
		debugLabel: 'activation-stamp-integration-failed',
		telemetry,
	})
}

export async function stampFirstJob(
	db: D1Database,
	input: { stableUserId: string; at?: string },
	telemetry?: OnboardingFunnelEnv | null,
): Promise<boolean> {
	return claimActivationStamp(db, {
		column: 'first_job_at',
		stableUserId: input.stableUserId,
		at: input.at,
		debugLabel: 'activation-stamp-job-failed',
		telemetry,
	})
}

/** Refresh last_active_at on login (and similar return signals). */
export async function touchLastActiveAt(
	db: D1Database,
	input: { stableUserId: string; at?: string },
): Promise<void> {
	try {
		const at = nowIso(input.at)
		await db
			.prepare(
				`UPDATE users
				SET last_active_at = ?1,
					updated_at = ?2
				WHERE stable_user_id = ?3
					AND (last_active_at IS NULL OR date(last_active_at) < date(?1))${andLiveDeletedAtSql()}`,
			)
			.bind(at, utcSqliteTimestamp(), input.stableUserId)
			.run()
	} catch (error) {
		console.debug('activation-touch-last-active-failed', error)
	}
}
