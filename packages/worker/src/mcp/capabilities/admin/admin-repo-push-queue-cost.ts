import { z } from 'zod'
import {
	loadRepoPushQueueCost,
	repoPushQueueCostDefaultDays,
	repoPushQueueCostMaxDays,
} from '#worker/admin/repo-push-queue-cost-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const pathSchema = z
	.enum(['queued', 'direct'])
	.describe(
		'queued = repo-push-queue Durable Object (flag on); direct = isolate-local wait-and-retry proxy (flag off).',
	)

const count = z.number().int().nonnegative()
const rate = z.number().nullable()

const pathRowSchema = z.object({
	path: pathSchema,
	pushes: count,
	ok: count.describe('2xx responses (git ref rejections included).'),
	busy: count.describe(
		'503 + Retry-After because the repo was busy (queue full, or the direct wait ran out).',
	),
	timeout: count.describe('Queue 90s budget expired (queued only).'),
	error: count.describe('Every other failure; see errors[] for names.'),
	failureRate: rate.describe('(busy + timeout + error) / pushes.'),
	busyOrTimeoutRate: rate.describe('(busy + timeout) / pushes.'),
	avgWallMs: rate.describe(
		'Average per-push wall time: Durable Object time (land + wait + send) for queued, proxy time for direct.',
	),
	maxWallMs: z.number().nonnegative(),
	totalWallSeconds: z
		.number()
		.nonnegative()
		.describe(
			'Sum of per-push wall time. For queued, an upper bound on Durable Object active time (concurrent pushes to one repo overlap).',
		),
	avgWaitMs: rate.describe('Average time before the first Artifacts send.'),
	maxWaitMs: z.number().nonnegative(),
	avgAttempts: rate.describe('Average Artifacts sends per push.'),
	retriedPushes: count.describe('Pushes with more than one Artifacts send.'),
	avgQueueDepth: rate.describe(
		'Average queue depth on arrival (0 for direct).',
	),
	maxQueueDepth: z.number().nonnegative(),
})

const inputSchema = z.object({
	days: z
		.number()
		.int()
		.min(1)
		.max(repoPushQueueCostMaxDays)
		.default(repoPushQueueCostDefaultDays)
		.describe(
			`UTC calendar days to include, ending today (default ${repoPushQueueCostDefaultDays}, max ${repoPushQueueCostMaxDays}).`,
		),
})

const outputSchema = z.object({
	days: z.number().int().positive(),
	startDay: z.string(),
	endDay: z.string(),
	available: z
		.boolean()
		.describe(
			'False when Analytics Engine is unreadable (local dev, missing credentials, query failure); paths are then all zero.',
		),
	reason: z.string().nullable(),
	paths: z.array(pathRowSchema),
	errors: z
		.array(
			z.object({
				path: pathSchema,
				errorName: z
					.string()
					.describe(
						'busy, timeout, queue_unavailable, too_large, body_timeout, upstream_4xx, upstream_5xx, or proxy_error.',
					),
				outcome: z.enum(['busy', 'timeout', 'error']),
				pushes: count,
			}),
		)
		.describe('Failed pushes grouped by path and error name, largest first.'),
	monthRollup: z
		.object({
			month: z.string(),
			pushes: z.number().nonnegative(),
			errors: z.number().nonnegative(),
			failureRate: rate,
			avgWallMs: rate,
		})
		.nullable()
		.describe(
			'Current UTC month from D1 usage_rollups (hourly from Analytics Engine in production; direct in local dev). Both paths combined.',
		),
})

export const adminRepoPushQueueCostCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminRepoPushQueueCost',
		contextRuns: 'deny',
		description:
			'Read-only cost and outcome aggregates for plain-repo git pushes (git_push usage events), split by path: queued (repo-push-queue Durable Object) vs direct (isolate-local wait-and-retry proxy). Per path: push count, ok/busy/timeout/error counts and rates, average and max wall time (Durable Object time for queued), total wall seconds, wait before the first Artifacts send, attempts and busy retries, and queue depth on arrival; plus failed pushes by error name. Default 7 days, max 31. The repo-push-queue flag readout in adminFeatureFlagList shows the matching on/off owner cohorts. Admin-only; aggregates only, never owners, usernames, or repo ids.',
		keywords: [
			'admin',
			'git push',
			'push queue',
			'repo-push-queue',
			'durable object',
			'cost',
			'busy',
			'receive-pack',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminRepoPushQueueCost',
				() => loadRepoPushQueueCost({ env: ctx.env, days: args.days }),
				{
					successReason: (result) =>
						`days=${result.days};available=${result.available}`,
				},
			)
		},
	},
)
