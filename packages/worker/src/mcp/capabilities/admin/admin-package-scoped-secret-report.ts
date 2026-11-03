import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

const packageLimitMax = 500

const inputSchema = z.object({
	packageLimit: z
		.number()
		.int()
		.min(1)
		.max(packageLimitMax)
		.default(100)
		.describe(
			'Max packages in per-package detail, most secrets first. Totals and per-org counts are never capped.',
		),
})

const outputSchema = z.object({
	totals: z.object({
		orgs: z.number().int().nonnegative(),
		packages: z.number().int().nonnegative(),
		secrets: z.number().int().nonnegative(),
		orphanedPackages: z
			.number()
			.int()
			.nonnegative()
			.describe('Buckets whose package is no longer a live saved package.'),
	}),
	orgs: z.array(
		z.object({
			orgId: z.string(),
			packages: z.number().int().nonnegative(),
			secrets: z.number().int().nonnegative(),
		}),
	),
	packagesTruncated: z.boolean(),
	packages: z
		.array(
			z.object({
				orgId: z.string(),
				packageId: z.string(),
				packageKodyId: z.string().nullable(),
				secrets: z.number().int().nonnegative(),
			}),
		)
		.describe(
			'Per-package detail for internal decisions only. Do not paste into public PR, issue, or commit text; use totals.',
		),
})

export type PackageScopedSecretReport = z.infer<typeof outputSchema>

type PackageRow = {
	org_id: string
	package_id: string
	package_kody_id: string | null
	secrets: number
}

/**
 * Live package-scope secrets with a value, by org and package. Same bucket
 * liveness as listPackageScopeSecretMetadata; disconnected rows hold no value
 * and are left out.
 */
export async function buildPackageScopedSecretReport(input: {
	db: D1Database
	packageLimit: number
	now?: string
}): Promise<PackageScopedSecretReport> {
	const now = input.now ?? new Date().toISOString()
	const { results } = await input.db
		.prepare(
			`SELECT b.user_id AS org_id, b.binding_key AS package_id,
				p.kody_id AS package_kody_id, COUNT(*) AS secrets
			FROM secret_buckets b
			JOIN secret_entries e ON e.bucket_id = b.id
			LEFT JOIN saved_packages p
				ON p.id = b.binding_key AND p.user_id = b.user_id${andLiveDeletedAtSql('p')}
			WHERE b.scope = 'package'
				AND (b.expires_at IS NULL OR b.expires_at > ?)
				AND e.encrypted_value != ''${andLiveDeletedAtSql('b')}${andLiveDeletedAtSql('e')}
			GROUP BY b.user_id, b.binding_key, p.kody_id
			ORDER BY secrets DESC, org_id ASC, package_id ASC`,
		)
		.bind(now)
		.all<PackageRow>()
	const rows = results ?? []
	const orgs = new Map<string, { packages: number; secrets: number }>()
	let secrets = 0
	let orphanedPackages = 0
	for (const row of rows) {
		const count = Number(row.secrets)
		secrets += count
		if (row.package_kody_id == null) orphanedPackages += 1
		const org = orgs.get(row.org_id) ?? { packages: 0, secrets: 0 }
		org.packages += 1
		org.secrets += count
		orgs.set(row.org_id, org)
	}
	return {
		totals: {
			orgs: orgs.size,
			packages: rows.length,
			secrets,
			orphanedPackages,
		},
		orgs: [...orgs]
			.map(([orgId, counts]) => ({ orgId, ...counts }))
			.sort(
				(left, right) =>
					right.secrets - left.secrets || left.orgId.localeCompare(right.orgId),
			),
		packagesTruncated: rows.length > input.packageLimit,
		packages: rows.slice(0, input.packageLimit).map((row) => ({
			orgId: row.org_id,
			packageId: row.package_id,
			packageKodyId: row.package_kody_id,
			secrets: Number(row.secrets),
		})),
	}
}

export const adminPackageScopedSecretReportCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminPackageScopedSecretReport',
		contextRuns: 'deny',
		description:
			'Read-only count of live package-scoped secrets (scope "package", with a value) by org and package, for the credential migration (issue #3375). An unsuffixed {{secret:NAME}} reads the package bucket before the user one, so codemod 0010 |scope= findings undercount these; report this next to the 0010 fleet report. Never returns secret names or values. Admin-only; use totals in public text.',
		keywords: [
			'admin',
			'credential',
			'secret',
			'package scope',
			'package-scoped',
			'migration',
			'0010',
			'3375',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			await resolveActingAdminPerson(ctx)
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageScopedSecretReport',
				async () =>
					await buildPackageScopedSecretReport({
						db: ctx.env.APP_DB,
						packageLimit: args.packageLimit,
					}),
				{
					successReason: (result) =>
						`orgs=${String(result.totals.orgs)};packages=${String(result.totals.packages)};secrets=${String(result.totals.secrets)}`,
				},
			)
		},
	},
)
