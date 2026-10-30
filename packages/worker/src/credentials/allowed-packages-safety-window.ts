/**
 * Issue #4129 safety window: the 30 days before
 * `allowedPackagesEnforcementCutoverAt`. While the
 * `credential-allowed-packages-safety-window` flag is on (global switch, on by
 * default), nothing is refused for a self-authored or adopted package that a
 * user credential's non-empty `allowed_packages` list leaves out. A pair whose
 * package and credential both existed before the window started is added to
 * the list on first use (one audit row with reason `grandfathered for #4129`
 * and source `safety_window`, one log line). Any other pair is quietly allowed
 * with a log line, and the would-block marker keeps recording it. It never
 * emails or notifies the owner. From cutover the rule is strict whatever the
 * flag says.
 */
import {
	isFeatureGloballyEnabled,
	isMissingFeatureFlagsTable,
} from '#worker/feature-flags/service.ts'
import { credentialAllowedPackagesSafetyWindowFlagKey } from '#universal/feature-flags/registry.ts'
import { optionalOrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { type AllowedPackagesWouldBlockAccessKind } from './allowed-packages-would-block.ts'
import {
	grantGrandfatheredPackageAccess,
	isBefore,
} from './allowed-packages-grant.ts'

/**
 * When non-empty allowed-packages lists become strict for every package: 30
 * days after this change went live. Until then the safety window below
 * applies while its flag is on.
 */
export const allowedPackagesEnforcementCutoverAt = '2026-11-30T00:00:00.000Z'
export const allowedPackagesSafetyWindowDays = 30

/** Start of the window: pairs that existed before this are approved on use. */
export function allowedPackagesSafetyWindowStartsAt(
	cutoverAt: string = allowedPackagesEnforcementCutoverAt,
) {
	return new Date(
		Date.parse(cutoverAt) - allowedPackagesSafetyWindowDays * 86_400_000,
	).toISOString()
}

/**
 * True while the window is open and the flag is on. A missing flags table
 * reads as off.
 */
export async function isAllowedPackagesSafetyWindowActive(input: {
	db: D1Database
	now?: Date
	cutoverAt?: string
}) {
	const now = input.now ?? new Date()
	if (
		now.toISOString() >=
		(input.cutoverAt ?? allowedPackagesEnforcementCutoverAt)
	) {
		return false
	}
	try {
		return await isFeatureGloballyEnabled(
			input.db,
			credentialAllowedPackagesSafetyWindowFlagKey,
		)
	} catch (error) {
		if (isMissingFeatureFlagsTable(error)) return false
		throw error
	}
}

export function existedBeforeAllowedPackagesSafetyWindow(
	createdAt: string,
	cutoverAt: string = allowedPackagesEnforcementCutoverAt,
) {
	return isBefore(createdAt, allowedPackagesSafetyWindowStartsAt(cutoverAt))
}

/**
 * Decide a refused pair while the window is open. Returns true when access
 * should be allowed. A pair whose package and credential both existed before
 * the window started is added to the list (audited, logged); any other pair is
 * quietly allowed and logged, and keeps its would-block marker. Never notifies
 * the owner. False once the window closes or with the flag off.
 */
export async function tryAllowedPackagesSafetyWindowGrant(input: {
	env: Pick<Env, 'APP_DB'>
	ownerId: string
	credentialId: string
	packageId: string
	packageCreatedAt: string
	accessKind: AllowedPackagesWouldBlockAccessKind
	now?: Date
	cutoverAt?: string
}): Promise<boolean> {
	const cutoverAt = input.cutoverAt ?? allowedPackagesEnforcementCutoverAt
	const db = input.env.APP_DB
	if (
		!(await isAllowedPackagesSafetyWindowActive({
			db,
			now: input.now,
			cutoverAt,
		}))
	) {
		return false
	}
	const ids = {
		ownerId: input.ownerId,
		credentialId: input.credentialId,
		packageId: input.packageId,
		accessKind: input.accessKind,
	}
	let outcome: Awaited<ReturnType<typeof grantPreWindowPair>> | 'error'
	try {
		outcome = await grantPreWindowPair({ ...input, db, cutoverAt })
	} catch (error) {
		// The grant is optional while the window is open; never refuse on it.
		outcome = 'error'
		console.warn(
			JSON.stringify({
				event: 'credential_allowed_packages_safety_window_grant_failed',
				...ids,
				error: error instanceof Error ? error.name : 'unknown',
			}),
		)
	}
	if (outcome === 'granted') {
		console.info(
			JSON.stringify({
				event: 'credential_allowed_packages_safety_window_grant',
				...ids,
			}),
		)
		return true
	}
	console.info(
		JSON.stringify({
			event: 'credential_allowed_packages_safety_window_allow',
			...ids,
		}),
	)
	return true
}

async function grantPreWindowPair(input: {
	env: Pick<Env, 'APP_DB'>
	db: D1Database
	ownerId: string
	credentialId: string
	packageId: string
	packageCreatedAt: string
	cutoverAt: string
}) {
	const windowStartsAt = allowedPackagesSafetyWindowStartsAt(input.cutoverAt)
	if (!isBefore(input.packageCreatedAt, windowStartsAt)) return 'not_eligible'
	// Package code hands this a narrow env; the audit writer reads AUDIT_DB from
	// the full worker env. No audit writer means no silent grant.
	const audit = optionalOrgAuditWriter(input.env as Env, null)
	if (!audit) return 'not_eligible'
	for (let attempt = 0; attempt < 2; attempt++) {
		const outcome = await grantGrandfatheredPackageAccess({
			db: input.db,
			audit,
			ownerId: input.ownerId,
			credentialId: input.credentialId,
			packageId: input.packageId,
			source: 'safety_window',
			credentialCreatedBefore: windowStartsAt,
		})
		if (outcome !== 'conflict') return outcome
	}
	return 'conflict'
}
