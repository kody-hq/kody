import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	jevSearchRerankOutcomes,
	toSlimStructuredMatches,
	type SlimSearchMatch,
} from '#mcp/tools/search-format.ts'
import { jevSearchKeepPaths } from '#mcp/tools/search-jev-rerank.ts'
import {
	elapsedMs,
	reconcileSearchPhaseTimings,
	runWithSearchDeadline,
	toSearchServerTiming,
} from '#mcp/tools/search-timing.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from '#mcp/tools/tool-call-context.ts'

const defaultSearchLimit = 15
const maxSearchLimit = 100
// Domain browsing (domain without query) deliberately lists the whole domain
// by default instead of cutting at the ranked default.
const domainBrowseDefaultLimit = 100

const memoryResultSchema = z.object({
	surfaced: z.array(z.unknown()),
	suppressedCount: z.number().int().nonnegative(),
	retrievalQuery: z.string(),
})

const jevRerankTelemetrySchema = z
	.object({
		enabled: z.boolean(),
		outcome: z.enum(jevSearchRerankOutcomes),
		candidatesBefore: z.number().int().nonnegative(),
		candidatesAfter: z.number().int().nonnegative(),
		droppedCount: z.number().int().nonnegative(),
		meanConfidence: z.number().nullable(),
		top1Type: z.string().nullable(),
		keepPath: z
			.enum(jevSearchKeepPaths)
			.optional()
			.describe(
				'Adaptive keep path after Jev Score (`kept-high` | `kept-lowered` | `kept-identity` | `empty`). Present when Score ran and mean confidence cleared the floor. `kept-identity` keeps package name, kody id, or leaf hits when every Score misses the floors.',
			),
		errorReason: z
			.string()
			.max(240)
			.optional()
			.describe(
				'Short reason when outcome is fallback-error (gateway auth/credits, incomplete Score answers). Omitted otherwise.',
			),
		model: z
			.literal('typesafe/jev')
			.optional()
			.describe(
				'Workers AI model when the Jev stage ran or attempted. Omitted when the flag is off.',
			),
		aiCallCount: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				'Number of Score AI.run calls (one per question batch). Present with model.',
			),
		usage: z
			.object({
				inputTokens: z.number().nonnegative().nullable(),
				outputTokens: z.number().nonnegative().nullable(),
			})
			.optional()
			.describe(
				'Summed Workers AI / Gateway token usage across Score batches. Nulls when the binding omitted usage.',
			),
	})
	.describe(
		'Jev Score rerank stage for list-mode ranked search. Present when the ranked path ran or skipped the stage. Omitted for domain overview, domain browse, empty discovery, and exact-package identity.',
	)

const searchOutputSchema = z.object({
	conversationId: z.string(),
	matches: z.array(z.unknown()),
	offline: z.boolean(),
	warnings: z.array(z.string()),
	guidance: z.string().optional(),
	memories: memoryResultSchema.optional(),
	telemetry: z
		.object({
			jevRerank: jevRerankTelemetrySchema,
		})
		.optional()
		.describe(
			'List-mode ranked search telemetry. Omitted when Jev never ran (entity-style short circuits, domain overview, domain browse, exact package identity).',
		),
	phaseTimings: z
		.object({
			jevRerankMs: z.number().nonnegative().optional(),
		})
		.optional()
		.describe(
			'Exclusive Jev rerank wall time in milliseconds when the ranked path computed the stage.',
		),
	serverTiming: z
		.array(
			z.object({
				name: z.string(),
				durationMs: z.number().nonnegative(),
			}),
		)
		.optional()
		.describe(
			'Request-scoped phase timings. Same shape as execute serverTiming. Not stored. Includes jevRerank when the Jev stage ran on the ranked path.',
		),
})

function normalizeLimit(
	limit: number | undefined,
	fallback = defaultSearchLimit,
) {
	if (!limit) return fallback
	return Math.max(1, Math.min(Math.floor(limit), maxSearchLimit))
}

export const searchCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'search',
		contextRuns: 'allow',
		orgPermission: 'search:read',
		description:
			'Search Kody capabilities, saved packages, integrations, and secret references using natural language or exact user-scoped package identity. An empty call returns the domain index. Pass "domain" to rank or list one capability domain. Use this inside package and execute runtimes when reusable code needs the same discovery surface as the public MCP search tool.',
		keywords: [
			'search',
			'discover',
			'capabilities',
			'packages',
			'integrations',
			'secrets',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			query: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Natural language description, or a scoped `@owner/leaf` name, current-origin account package URL, owner-matching hosted package URL, or an exact saved-package UUID (`package_id`) when the name is not known. Optional when "domain" is provided.',
				),
			domain: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional capability domain id (for example "email" or "mcp:linear"). With "query", ranks only that domain\'s capabilities; without "query", lists the domain\'s capabilities.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(maxSearchLimit)
				.optional()
				.describe('Max number of ranked results to return. Defaults to 15.'),
			conversationId: conversationIdInputField,
			memoryContext: memoryContextInputField,
			includeHiddenPackages: z
				.boolean()
				.optional()
				.describe(
					'Include hidden packages in search results (hidden packages are excluded by default).',
				),
		}),
		outputSchema: searchOutputSchema,
		async handler(
			args: {
				query?: string
				domain?: string
				limit?: number
				conversationId?: string
				memoryContext?: z.infer<typeof memoryContextInputField>
				includeHiddenPackages?: boolean
			},
			ctx: CapabilityContext,
		) {
			const query = args.query?.trim() ?? ''
			const domainFilter = args.domain?.trim() || undefined
			const conversationId = resolveConversationId(args.conversationId)
			// person-keyed (not personal org): metering / conversation identity
			const userId = ctx.callerContext.user
				? personalOrgId(ctx.callerContext.user.userId)
				: null
			const includeHiddenPackages = !!args.includeHiddenPackages
			const startedAt = performance.now()
			// Deliberately dynamic: search-execution loads the capability registry,
			// which includes this meta capability.
			const { executeSearchList } =
				await import('#mcp/tools/search-execution.ts')
			const execution = await runWithSearchDeadline((signal) =>
				executeSearchList({
					signal,
					env: ctx.env,
					callerContext: ctx.callerContext,
					conversationId,
					query,
					...(args.query !== undefined ? { memoryQuery: args.query } : {}),
					limit: normalizeLimit(
						args.limit,
						domainFilter && !query ? domainBrowseDefaultLimit : undefined,
					),
					userId,
					includeHiddenPackages,
					memoryContext: args.memoryContext,
					...(domainFilter ? { domain: domainFilter } : {}),
				}),
			)
			const jevRerank = execution.result.telemetry.jevRerank
			const jevRerankMs = execution.result.phaseTimings.jevRerankMs
			const serverTiming = toSearchServerTiming({
				phaseTimings: reconcileSearchPhaseTimings({
					durationMs: elapsedMs(startedAt),
					phaseTimings: {
						...execution.result.phaseTimings,
						...execution.phaseTimings,
					},
				}),
				jevRerank,
			})
			return {
				conversationId,
				matches: toSlimStructuredMatches({
					matches: execution.result.matches,
					baseUrl: ctx.callerContext.baseUrl,
					username: execution.username,
				}) as Array<SlimSearchMatch>,
				offline: execution.result.offline,
				warnings: execution.warnings,
				...(execution.capabilityGuidance
					? { guidance: execution.capabilityGuidance }
					: {}),
				...(execution.memorySettlement.memories
					? {
							memories: execution.memorySettlement.memories,
						}
					: {}),
				...(jevRerank
					? {
							telemetry: { jevRerank },
						}
					: {}),
				...(jevRerankMs != null
					? {
							phaseTimings: { jevRerankMs },
						}
					: {}),
				...(serverTiming.length > 0 ? { serverTiming } : {}),
			}
		},
	},
)
