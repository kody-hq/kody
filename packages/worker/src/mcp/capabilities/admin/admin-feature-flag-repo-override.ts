import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	clearFeatureFlagRepoOverride,
	evaluateRepoFeatureFlag,
	listFeatureFlagRepoOverrides,
	setFeatureFlagRepoOverride,
} from '#worker/feature-flags/repo-flags.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import {
	adminCapabilityAccess,
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import { assertFeatureFlagKey } from './feature-flag-shared.ts'

const sourceIdSchema = z
	.string()
	.uuid()
	.describe(
		'Repo source id (entity_sources.id): the {id} in a /git/sources/{id}.git remote.',
	)

const repoOverrideSchema = z.object({
	sourceId: z.string(),
	enabled: z.boolean(),
	updatedByStableUserId: z.string().nullable(),
	updatedAt: z.string(),
})

const repoEvaluationSchema = z.object({
	enabled: z.boolean(),
	source: z.enum(['override', 'org', 'global', 'rollout', 'default']),
	repoOverride: z.boolean(),
})

async function requireLiveSource(db: D1Database, sourceId: string) {
	const source = await getEntitySourceById(db, sourceId)
	if (!source) {
		throw new McpCallerError(`No live repo source with id ${sourceId}.`)
	}
	return source
}

const overrideInputSchema = z
	.object({
		key: z.string().min(1).describe('Feature flag key from the code registry.'),
		sourceId: sourceIdSchema,
		enabled: z
			.boolean()
			.optional()
			.describe(
				'Allowlist state for this repo. Required unless clear is true.',
			),
		clear: z
			.boolean()
			.optional()
			.describe(
				'When true, remove the repo allowlist row instead of setting it.',
			),
	})
	.superRefine((value, context) => {
		const clear = value.clear === true
		if (clear && value.enabled !== undefined) {
			context.addIssue({
				code: 'custom',
				message: 'Do not provide enabled when clear is true.',
				path: ['enabled'],
			})
		}
		if (!clear && value.enabled === undefined) {
			context.addIssue({
				code: 'custom',
				message:
					'Provide enabled when setting a repo override, or clear: true.',
				path: ['enabled'],
			})
		}
	})

export const adminFeatureFlagRepoOverrideCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminFeatureFlagRepoOverride',
		contextRuns: 'deny',
		description:
			'Set or clear a per-repo feature flag allowlist row (repo-scoped flags such as repo-push-queue) by repo source id. The repo row wins over owner overrides, rollout, and audience. Returns the repo evaluation and the flag repo allowlist. Admin-only; never returns user content.',
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'override',
			'per-repo',
			'allowlist',
			'repo',
			'push queue',
		],
		inputSchema: overrideInputSchema,
		outputSchema: z.object({
			key: z.string(),
			sourceId: z.string(),
			cleared: z.boolean(),
			evaluation: repoEvaluationSchema,
			repoOverrides: z.array(repoOverrideSchema),
		}),
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminFeatureFlagRepoOverride',
				async () => {
					const key = assertFeatureFlagKey(args.key)
					const db = ctx.env.APP_DB
					const source = await requireLiveSource(db, args.sourceId)
					const clear = args.clear === true
					if (clear) {
						const cleared = await clearFeatureFlagRepoOverride(db, {
							key,
							sourceId: source.id,
						})
						if (!cleared) {
							throw new McpCallerError(
								`No repo override exists for feature flag "${key}" and source ${source.id}.`,
							)
						}
					} else {
						const admin = await resolveActingAdminPerson(ctx)
						await setFeatureFlagRepoOverride(db, {
							key,
							sourceId: source.id,
							enabled: args.enabled === true,
							updatedByStableUserId: admin.stableUserId,
						})
					}
					return {
						key,
						sourceId: source.id,
						cleared: clear,
						evaluation: await evaluateRepoFeatureFlag(db, key, {
							sourceId: source.id,
							ownerId: source.user_id,
						}),
						repoOverrides: await listFeatureFlagRepoOverrides(db, key),
					}
				},
				{
					successReason: ({ key, sourceId, cleared, evaluation }) =>
						`key=${key};source=${sourceId};cleared=${cleared};enabled=${evaluation.enabled}`,
				},
			)
		},
	},
)

export const adminFeatureFlagRepoCheckCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminFeatureFlagRepoCheck',
		contextRuns: 'deny',
		description:
			'Evaluate a repo-scoped feature flag (such as repo-push-queue) for one repo source id and list the flag repo allowlist. Shows whether the repo is on and which rule decided it (override, global, rollout, default). Admin-only; never returns user content.',
		keywords: [
			'admin',
			'feature flags',
			'flags',
			'per-repo',
			'allowlist',
			'repo',
			'push queue',
			'check',
		],
		inputSchema: z.object({
			key: z
				.string()
				.min(1)
				.describe('Feature flag key from the code registry.'),
			sourceId: sourceIdSchema,
		}),
		outputSchema: z.object({
			key: z.string(),
			sourceId: z.string(),
			evaluation: repoEvaluationSchema,
			repoOverrides: z.array(repoOverrideSchema),
		}),
		async handler(args, ctx: CapabilityContext) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminFeatureFlagRepoCheck',
				async () => {
					const key = assertFeatureFlagKey(args.key)
					const db = ctx.env.APP_DB
					const source = await requireLiveSource(db, args.sourceId)
					return {
						key,
						sourceId: source.id,
						evaluation: await evaluateRepoFeatureFlag(db, key, {
							sourceId: source.id,
							ownerId: source.user_id,
						}),
						repoOverrides: await listFeatureFlagRepoOverrides(db, key),
					}
				},
				{
					successReason: ({ key, sourceId, evaluation }) =>
						`key=${key};source=${sourceId};enabled=${evaluation.enabled}`,
				},
			)
		},
	},
)
