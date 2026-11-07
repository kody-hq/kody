import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { loadPackageProvenance } from '#worker/admin/package-provenance.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const commitShaSchema = z
	.string()
	.trim()
	.regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i, 'Expected a full commit SHA.')

const inputSchema = z
	.object({
		packageId: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe('Saved package id (UUID) of any owner.'),
		packageName: z
			.string()
			.trim()
			.regex(/^@[^/\s]+\/[^/\s]+$/, 'Expected @owner/name.')
			.optional()
			.describe('Scoped package name, @owner/name.'),
		ancestry: z
			.object({
				ancestor: commitShaSchema.describe('Commit A.'),
				descendant: commitShaSchema.describe('Commit B.'),
			})
			.optional()
			.describe(
				"Check whether ancestor is an ancestor of descendant in the package's repo, computed platform-side.",
			),
	})
	.refine(
		(value) =>
			[value.packageId, value.packageName].filter(Boolean).length === 1,
		{ message: 'Provide exactly one of packageId or packageName.' },
	)

const nullableString = z.string().nullable()

const outputSchema = z.object({
	package: z.object({
		packageId: z.string(),
		kodyId: z.string(),
		name: z.string(),
		ownerId: z.string(),
		ownerHandle: nullableString,
		sourceId: z.string(),
	}),
	source: z
		.object({
			publishedCommit: nullableString.describe(
				'entity_sources.published_commit: the commit the last publish recorded.',
			),
			servingCommit: nullableString.describe(
				'The commit runtime serves: serving_commit, or published_commit when no serving pointer is set.',
			),
			servingArtifactCommit: nullableString.describe(
				'serving_commit only: the commit whose complete build is proven. Null when no complete build is recorded at published_commit.',
			),
		})
		.nullable(),
	artifacts: z
		.array(
			z.object({
				kind: z.string(),
				name: nullableString,
				entryPoint: z.string(),
				builtFromCommit: z.string(),
				updatedAt: z.string(),
			}),
		)
		.describe('Saved bundle artifacts and the commit each was built from.'),
	jobs: z.array(
		z.object({
			jobId: z.string(),
			name: z.string(),
			enabled: z.boolean(),
			scheduleType: z.string(),
			recordedCommit: nullableString.describe(
				'jobs.published_commit recorded when the job was created or refreshed.',
			),
			runsCommit: nullableString.describe(
				'The package serving commit a run resolves to.',
			),
			lastRunAt: nullableString,
			lastRunStatus: nullableString,
			lastRunErrorClass: nullableString,
			nextRunAt: z.string(),
		}),
	),
	triggers: z
		.array(
			z.object({
				kind: z.string(),
				name: z.string(),
				state: z.string(),
				pinnedCommit: z.null(),
				runsCommit: nullableString,
				updatedAt: z.string(),
			}),
		)
		.describe(
			'Cron, subscription, and webhook enablements. Triggers are not pinned; each run resolves the serving commit.',
		),
	webhooks: z.array(
		z.object({
			endpointId: z.string(),
			name: z.string(),
			pinnedCommit: z.null(),
			runsCommit: nullableString,
			createdAt: z.string(),
		}),
	),
	publishRuns: z
		.array(
			z.object({
				id: z.string(),
				kind: z.enum(['publish_workflow', 'publish_build']),
				status: nullableString,
				commit: nullableString,
				createdAt: z.string(),
				updatedAt: z.string(),
				completedAt: nullableString,
				errorClass: nullableString.describe(
					'Short error class (error name or snake_case code), never the message.',
				),
			}),
		)
		.describe('Most recent publish workflows and uploaded publish builds.'),
	publishRunsComplete: z
		.boolean()
		.describe("False when the owner's RunLog could not be read."),
	ancestry: z
		.object({
			ancestor: z.string(),
			descendant: z.string(),
			result: z.enum([
				'ancestor',
				'not_ancestor',
				'unknown_commit',
				'repo_unavailable',
			]),
			isAncestor: z.boolean().nullable(),
			unknownCommits: z.array(z.string()),
		})
		.nullable(),
})

export const adminPackageProvenanceCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminPackageProvenance',
		contextRuns: 'deny',
		description:
			"Read-only provenance for any owner's package, for diagnosing which commit a package is serving or a stuck publish on another owner's package. Target by packageId or @owner/name. Returns the published commit, the serving commit and the commit the served bundle artifacts were built from, the commit each job, schedule, trigger, and webhook is pinned to or runs, and recent publish runs (id, status, commit, timestamps, short error class). Optional ancestry pair checks whether commit A is an ancestor of commit B in the package repo, computed platform-side. Admin-only and audit-logged; SHAs and metadata only, never file contents, logs, error messages, tokens, or secrets.",
		keywords: [
			'admin',
			'package provenance',
			'which commit is a package serving',
			'serving commit',
			'published commit',
			'built from commit',
			'job pinned commit',
			'trigger pinned commit',
			'webhook pinned commit',
			'is commit ancestor',
			'ancestry',
			'stuck publish',
			'stuck publish other owner package',
			'publish history',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const target = args.packageId
				? { packageId: args.packageId }
				: { packageName: args.packageName ?? '' }
			const targetReason = target.packageId
				? `package_id=${target.packageId}`
				: `package_name=${target.packageName}`
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPackageProvenance',
				async () => {
					const result = await loadPackageProvenance({
						env: ctx.env,
						target,
						ancestry: args.ancestry ?? null,
					}).catch((error: unknown) => {
						throw new Error(`${targetReason} provenance_read_failed`, {
							cause: error,
						})
					})
					if (!result) {
						throw new McpCallerError(`Package not found (${targetReason}).`)
					}
					return result
				},
				{
					successReason: (result) =>
						[
							`package_id=${result.package.packageId}`,
							`owner_id=${result.package.ownerId}`,
							`ancestry=${result.ancestry?.result ?? 'none'}`,
						].join(' '),
				},
			)
		},
	},
)
