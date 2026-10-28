/**
 * Issue #4129 safety window. For 30 days after enforcement cutover, a
 * self-authored or adopted package refused on a user credential whose
 * non-empty `allowed_packages` list leaves it out is approved on first use
 * instead, when both the package and the credential existed before cutover.
 * The grant adds the package to the list, writes one audit row (reason
 * `grandfathered for #4129`, source `safety_window`) and one log line. It
 * never emails or notifies the owner. Behind the
 * `credential-allowed-packages-safety-window` flag (global switch, off by
 * default). After the window closes the rule is strict whatever the flag says.
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

/** When non-empty allowed-packages lists became enforced for every package. */
export const allowedPackagesEnforcementCutoverAt = '2026-11-02T00:00:00.000Z'
export const allowedPackagesSafetyWindowDays = 30

export function allowedPackagesSafetyWindowEndsAt(
	cutoverAt: string = allowedPackagesEnforcementCutoverAt,
) {
	return new Date(
		Date.parse(cutoverAt) + allowedPackagesSafetyWindowDays * 86_400_000,
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
	if (now.toISOString() >= allowedPackagesSafetyWindowEndsAt(input.cutoverAt)) {
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

export function existedBeforeAllowedPackagesCutover(
	createdAt: string,
	cutoverAt: string = allowedPackagesEnforcementCutoverAt,
) {
	return isBefore(createdAt, cutoverAt)
}

/**
 * Approve the package on the credential when the window covers this pair.
 * Returns true when access should be allowed (granted now, or a concurrent
 * write already allowed it). Never notifies the owner.
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
	if (!existedBeforeAllowedPackagesCutover(input.packageCreatedAt, cutoverAt)) {
		return false
	}
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
	// Package code hands this a narrow env; the audit writer reads AUDIT_DB from
	// the full worker env. No audit writer means no silent grant.
	const audit = optionalOrgAuditWriter(input.env as Env, null)
	if (!audit) return false
	for (let attempt = 0; attempt < 2; attempt++) {
		const outcome = await grantGrandfatheredPackageAccess({
			db,
			audit,
			ownerId: input.ownerId,
			credentialId: input.credentialId,
			packageId: input.packageId,
			source: 'safety_window',
			credentialCreatedBefore: cutoverAt,
		})
		if (outcome === 'conflict') continue
		if (outcome === 'granted') {
			console.info(
				JSON.stringify({
					event: 'credential_allowed_packages_safety_window_grant',
					ownerId: input.ownerId,
					credentialId: input.credentialId,
					packageId: input.packageId,
					accessKind: input.accessKind,
				}),
			)
		}
		return outcome === 'granted' || outcome === 'already_allowed'
	}
	return false
}
