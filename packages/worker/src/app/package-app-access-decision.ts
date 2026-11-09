import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import { deferWork } from '#worker/deferred-work.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * KV cache of package-app access decisions, consulted when a visitor's access
 * ticket expires (`package-app-ticket.ts`).
 *
 * A decision is keyed by org, org `access_epoch`, visitor, and app. Every
 * membership, team, grant, and app visibility write bumps the epoch in the
 * same D1 batch (`access-epoch-write-guard.ts`), so a bump makes every older
 * decision for the org unreachable without deleting anything. The current
 * epoch is read from D1 on each refresh, not mirrored in KV: revocation then
 * waits only for outstanding tickets to expire, never for KV propagation, and
 * no write path ever touches a hot per-org KV key. Decision keys are written
 * once per visitor, app, and epoch.
 */

const decisionKeyPrefix = 'package-app-access:v1'
const decisionTtlSeconds = 24 * 60 * 60
/** Fraction of ticket-authorized requests that log an allow line. */
export const packageAppAllowLogSampleRate = 0.01

export type PackageAppAccessDecision = {
	allowed: boolean
	role: OrgRole | null
}

const orgRoles: ReadonlyArray<OrgRole> = ['owner', 'admin', 'member', 'billing']

function isDecision(value: unknown): value is PackageAppAccessDecision {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		typeof record.allowed === 'boolean' &&
		(record.role === null || orgRoles.includes(record.role as OrgRole))
	)
}

function decisionKey(input: {
	orgId: string
	epoch: number
	visitorId: string
	appId: string | null
}) {
	return `${decisionKeyPrefix}:${input.orgId}:${input.epoch}:${input.visitorId}:${input.appId ?? '-'}`
}

/** Live org `access_epoch`, or null when the org is gone. */
export async function readOrgAccessEpoch(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT access_epoch FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ access_epoch: number }>()
	return row ? Number(row.access_epoch) || 0 : null
}

/**
 * Cached decision for this epoch, or null on a miss. A KV failure is also a
 * miss: the caller then runs the full D1 access check, so nothing is ever
 * allowed without a successful verification.
 */
export async function readCachedPackageAppAccessDecision(input: {
	env: Env
	orgId: string
	epoch: number
	visitorId: string
	appId: string | null
}): Promise<PackageAppAccessDecision | null> {
	try {
		const stored = await input.env.BUNDLE_ARTIFACTS_KV.get(
			decisionKey(input),
			'json',
		)
		return isDecision(stored) ? stored : null
	} catch (error) {
		console.warn('package-app-access-decision-read-failed', error)
		return null
	}
}

export function cachePackageAppAccessDecision(input: {
	env: Env
	orgId: string
	epoch: number
	visitorId: string
	appId: string | null
	decision: PackageAppAccessDecision
}) {
	void deferWork('package-app-access-decision-write-failed', () =>
		input.env.BUNDLE_ARTIFACTS_KV.put(
			decisionKey(input),
			JSON.stringify(input.decision),
			{ expirationTtl: decisionTtlSeconds },
		),
	)
}

/** Durable audit row for a ticket mint or an access denial. */
export function logPackageAppAccessEvent(input: {
	env: Env
	request: Request
	outcome: 'ticket-minted' | 'denied'
	visitorEmail: string
	orgHandle: string
	appSlug: string
	reason: string
}) {
	void deferWork('package-app-access-audit-failed', () =>
		logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'auth',
			action:
				input.outcome === 'ticket-minted'
					? 'package_app_ticket_mint'
					: 'package_app_access_denied',
			result: input.outcome === 'ticket-minted' ? 'success' : 'failure',
			email: input.visitorEmail,
			path: new URL(input.request.url).pathname,
			reason: `${input.orgHandle}/${input.appSlug}: ${input.reason}`,
		}),
	)
}

/** Sampled log line for a request authorized by a valid ticket. */
export function logSampledPackageAppTicketAllow(input: {
	orgHandle: string
	appSlug: string
	role: OrgRole | null
	random?: () => number
}) {
	if ((input.random ?? Math.random)() >= packageAppAllowLogSampleRate) return
	console.info('package-app-access-allow', {
		via: 'ticket',
		org: input.orgHandle,
		app: input.appSlug,
		role: input.role ?? 'grant',
		sampleRate: packageAppAllowLogSampleRate,
	})
}
