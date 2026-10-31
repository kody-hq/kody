/**
 * Issue #4129 safety window: the 30 days before
 * `allowedPackagesEnforcementCutoverAt`. While the
 * `credential-allowed-packages-safety-window` flag is on (global switch, on by
 * default), nothing is refused for a self-authored or adopted package that a
 * user credential's non-empty `allowed_packages` list leaves out. The use is
 * allowed with a log line and the would-block marker keeps recording it. The
 * list is never written, so an owner who removes a package keeps it removed
 * (#4637). It never emails or notifies the owner. From cutover the rule is
 * strict whatever the flag says.
 */
import {
	isFeatureGloballyEnabled,
	isMissingFeatureFlagsTable,
} from '#worker/feature-flags/service.ts'
import { credentialAllowedPackagesSafetyWindowFlagKey } from '#universal/feature-flags/registry.ts'
import { type AllowedPackagesWouldBlockAccessKind } from './allowed-packages-would-block.ts'

/**
 * When non-empty allowed-packages lists become strict for every package: 30
 * days after this change went live. Until then the safety window below
 * applies while its flag is on.
 */
export const allowedPackagesEnforcementCutoverAt = '2026-11-30T00:00:00.000Z'

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

/**
 * Decide a refused pair while the window is open. Returns true when access
 * should be allowed: the use is logged and keeps its would-block marker, and
 * the allowed list is left as the owner set it. Never notifies the owner.
 * False once the window closes or with the flag off.
 */
export async function allowDuringAllowedPackagesSafetyWindow(input: {
	env: Pick<Env, 'APP_DB'>
	ownerId: string
	credentialId: string
	packageId: string
	accessKind: AllowedPackagesWouldBlockAccessKind
	now?: Date
	cutoverAt?: string
}): Promise<boolean> {
	if (
		!(await isAllowedPackagesSafetyWindowActive({
			db: input.env.APP_DB,
			now: input.now,
			cutoverAt: input.cutoverAt,
		}))
	) {
		return false
	}
	console.info(
		JSON.stringify({
			event: 'credential_allowed_packages_safety_window_allow',
			ownerId: input.ownerId,
			credentialId: input.credentialId,
			packageId: input.packageId,
			accessKind: input.accessKind,
		}),
	)
	return true
}
