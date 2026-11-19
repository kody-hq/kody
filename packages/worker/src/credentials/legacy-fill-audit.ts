import { waitUntil } from 'cloudflare:workers'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { auditDatabaseFromEnv } from '#worker/audit-log.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import type { CredentialFillSite } from './fill-placement.ts'
import type { PackageStamp } from './package-stamp.ts'
import { reportOrgAuditWriteFailure } from './report-org-audit-write-failure.ts'

export const legacyFillAuditAction = 'credential.legacy_fill'
export const legacyFillPlacements = [
	'header',
	'query',
	'path',
	'body',
	'url-authority',
] as const
export const legacyFillModes = [
	'need',
	'name',
	'provider',
	'integration',
	'unknown',
] as const
export const legacyFillSurfaces = [
	'execute',
	'package',
	'package-app',
	'local',
	'email',
	'webhook',
	'schedule',
	'event',
] as const
type LegacyFillPlacement = (typeof legacyFillPlacements)[number]
export type LegacyFillMode = (typeof legacyFillModes)[number]

export function recordLegacyFill(input: {
	env: Env
	orgId: string | null
	request: RequestContext | null
	packageStamp: PackageStamp | null
	packageApp: boolean
	sites: ReadonlyArray<
		Pick<CredentialFillSite, 'part'> | { part: 'url-authority' }
	>
	mode: LegacyFillMode
	result: 'success' | 'failure' | 'denied'
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const { orgId } = input
	if (!orgId || input.sites.length === 0) return
	const db = auditDatabaseFromEnv(input.env)
	if (db === undefined) return
	const counts: Partial<Record<LegacyFillPlacement, number>> = {}
	for (const { part } of input.sites) counts[part] = (counts[part] ?? 0) + 1
	const surface = input.packageApp
		? 'package-app'
		: input.request?.attribution.kind === 'automation'
			? input.request.attribution.source
			: input.packageStamp?.kind === 'claimed' ||
				  input.request?.credential.kind === 'cli'
				? 'local'
				: input.packageStamp
					? 'package'
					: 'execute'
	const event = { orgId, action: legacyFillAuditAction, result: input.result }
	const work = logOrgAuditEvent({
		...event,
		db,
		resourceId: input.packageStamp?.packageId ?? null,
		details: { surface, mode: input.mode, counts },
	}).catch((error: unknown) => {
		reportOrgAuditWriteFailure(
			'Failed to record legacy credential placement:',
			event,
			error,
		)
	})
	;(input.waitUntil ?? waitUntil)(work)
}
