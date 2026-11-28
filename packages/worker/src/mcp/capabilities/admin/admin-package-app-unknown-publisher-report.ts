import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

const outputSchema = z.object({
	unknownPublisherApps: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Live app packages whose last publish had no known person and that have no Owner-picked runs-as person.',
		),
	personalOrgApps: z
		.number()
		.int()
		.nonnegative()
		.describe('Of those, apps in a personal org: they run as the org owner.'),
	teamOrgApps: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Of those, apps in a team org: no one to run as until an Owner publishes or picks someone.',
		),
})

export type PackageAppUnknownPublisherReport = z.infer<typeof outputSchema>

/** Counts only; never package, org, or person ids. */
export async function buildPackageAppUnknownPublisherReport(
	db: D1Database,
): Promise<PackageAppUnknownPublisherReport> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS total,
				COALESCE(SUM(CASE WHEN EXISTS (
					SELECT 1 FROM users u
					WHERE (u.personal_org_id = a.owner_id OR u.stable_user_id = a.owner_id)${andLiveDeletedAtSql('u')}
				) THEN 1 ELSE 0 END), 0) AS personal
			FROM package_app_authority a
			JOIN saved_packages p ON p.id = a.package_id AND p.user_id = a.owner_id
			WHERE a.publisher_unknown = 1
				AND TRIM(COALESCE(a.runs_as_person_id, '')) = ''
				AND p.has_app = 1${andLiveDeletedAtSql('p')}`,
		)
		.first<{ total: number; personal: number }>()
	const total = Number(row?.total ?? 0)
	const personal = Number(row?.personal ?? 0)
	return {
		unknownPublisherApps: total,
		personalOrgApps: personal,
		teamOrgApps: total - personal,
	}
}

export const adminPackageAppUnknownPublisherReportCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminPackageAppUnknownPublisherReport',
		contextRuns: 'deny',
		description:
			'Read-only counts of live app packages whose last publish had no known person (publisher_unknown) and no Owner-picked runs-as person, split into personal orgs (run as the org owner) and team orgs (no one to run as). Counts only. Admin-only.',
		keywords: [
			'admin',
			'package app',
			'runs as',
			'publisher unknown',
			'publisher_unknown',
			'report',
		],
		inputSchema: z.object({}),
		outputSchema,
		async handler(_args, ctx) {
			await resolveActingAdminPerson(ctx)
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageAppUnknownPublisherReport',
				async () => await buildPackageAppUnknownPublisherReport(ctx.env.APP_DB),
				{
					successReason: (result) =>
						`apps=${String(result.unknownPublisherApps)};team=${String(result.teamOrgApps)}`,
				},
			)
		},
	})
