import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	listSelfServeExperimentsForUser,
	readUserIdForPerson,
	setSelfServeExperimentForUser,
} from '#worker/feature-flags/self-serve-experiments.ts'
import { selfServeExperimentIds } from '#universal/feature-flags/experiments.ts'
import { requireMcpRequest, requireMcpUser } from './require-user.ts'

const experimentSchema = z.object({
	id: z.enum(selfServeExperimentIds),
	title: z.string(),
	summary: z.string(),
	stage: z.string(),
	enabled: z.boolean().describe('Whether it is on for this person now.'),
	choice: z
		.enum(['you', 'kody'])
		.describe(
			'`you`: the person turned it on or off. `kody`: Kody decided and the person has not chosen.',
		),
	docs_url: z.string(),
	manage_url: z.string().describe('Experiments page with every toggle.'),
})

async function requirePerson(ctx: CapabilityContext) {
	const request = requireMcpRequest(ctx.callerContext)
	if (!request.actor) {
		throw new McpCallerError(
			'Experiments belong to a person. Sign in as a person, not a team org or service token.',
		)
	}
	const userId = await readUserIdForPerson(ctx.env.APP_DB, request.actor.userId)
	if (userId === null) {
		throw new McpCallerError('No Kody account for this person.')
	}
	return { request, userId }
}

async function listFor(ctx: CapabilityContext, userId: number, orgId: string) {
	const base = ctx.callerContext.baseUrl
	return (
		await listSelfServeExperimentsForUser(ctx.env.APP_DB, userId, orgId)
	).map((experiment) => ({
		id: experiment.id,
		title: experiment.title,
		summary: experiment.summary,
		stage: experiment.stage,
		enabled: experiment.enabled,
		choice: experiment.choice,
		docs_url: new URL(experiment.docsPath, base).href,
		manage_url: new URL('/account/experiments', base).href,
	}))
}

export const experimentListCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'experimentList',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'List the self-serve Kody experiments (execution contexts, package skills over MCP, MCP Events) with a plain-language summary, docs link, and whether each is on for the signed-in person. Use when a feature says it is behind a feature flag, or the person asks what experiments exist. Turn one on or off with experimentSet when the person asks.',
		keywords: [
			'experiment',
			'experiments',
			'feature flag',
			'flag off',
			'feature_disabled',
			'opt in',
			'beta',
			'early access',
			'execution contexts',
			'package skills',
			'mcp events',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: z.object({ experiments: z.array(experimentSchema) }),
		async handler(_args, ctx: CapabilityContext) {
			const { request, userId } = await requirePerson(ctx)
			return { experiments: await listFor(ctx, userId, request.org.id) }
		},
	},
)

export const experimentSetCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'experimentSet',
		contextRuns: 'deny',
		orgPermission: 'none',
		requiresLivePerson: true,
		description:
			'Turn one self-serve Kody experiment on or off for the signed-in person only, the same as the toggle on the Experiments page. Call it only when the person asks to try (or leave) the experiment; read its docs_url from experimentList first. Turning one off sticks even if Kody later rolls it out wider.',
		keywords: [
			'experiment',
			'feature flag',
			'opt in',
			'opt out',
			'enable',
			'turn on',
			'try',
			'execution contexts',
			'package skills',
			'mcp events',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			experiment: z
				.enum(selfServeExperimentIds)
				.describe('Experiment id from experimentList.'),
			enabled: z.boolean().describe('true turns it on, false turns it off.'),
		}),
		outputSchema: experimentSchema,
		async handler(args, ctx: CapabilityContext) {
			const { request, userId } = await requirePerson(ctx)
			const definition = await setSelfServeExperimentForUser(ctx.env.APP_DB, {
				userId,
				id: args.experiment,
				enabled: args.enabled,
			})
			void logAuditEvent({
				db: auditDatabaseFromEnv(ctx.env),
				category: 'account',
				action: args.enabled
					? 'feature_flag_self_opt_in'
					: 'feature_flag_self_opt_out',
				result: 'success',
				email: requireMcpUser(ctx.callerContext).email,
				path: '/mcp',
				reason: `key=${definition.flagKey}`,
			})
			const state = (await listFor(ctx, userId, request.org.id)).find(
				(experiment) => experiment.id === args.experiment,
			)
			if (!state) throw new McpCallerError('Unknown experiment.')
			return state
		},
	},
)
