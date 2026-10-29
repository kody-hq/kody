import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	resolvePersonId,
	resolveTeamId,
} from '#mcp/capabilities/access/shared.ts'
import {
	attachContext,
	chainResponse,
	detachContext,
	getContextDetail,
	getSharing,
	listAudit,
	listContexts,
	listRuns,
	optIn,
	optOut,
	removeShare,
	requireExecutionContextsCaller,
	revokeContext,
	setChain,
	setSharing,
	updateContext,
} from '#worker/execution-contexts/service.ts'

const domain = capabilityDomainNames.executionContexts
const idSchema = z
	.string()
	.min(1)
	.describe('Execution context id (ec_...) or its name in this org.')

function caller(ctx: CapabilityContext) {
	return requireExecutionContextsCaller(ctx)
}

const chainEntrySchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('context'), id: z.string().min(1) }),
	z.object({ kind: z.literal('cloud') }),
])

export const executionContextListCapability = defineDomainCapability(domain, {
	name: 'executionContextList',
	contextRuns: 'allow',
	orgPermission: 'execution_context:read',
	description:
		'List execution contexts (machines running `kody daemon`) visible in this org: yours, ones shared with you, and ones attached to this org. Each item says whether you can use it, why not (unusableReason), whether it is in your chain, and its grant summary. The response also lists usable contexts that are in none of your chain (unutilized).',
	keywords: [
		'execution context',
		'machine',
		'daemon',
		'local',
		'build server',
		'runner',
	],
	readOnly: true,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({}),
	async handler(_args, ctx) {
		return await listContexts(await caller(ctx))
	},
})

export const executionContextGetCapability = defineDomainCapability(domain, {
	name: 'executionContextGet',
	contextRuns: 'allow',
	orgPermission: 'execution_context:read',
	description:
		'Get one execution context with status, grants, your access, chain usage, and (for its operator, Manage holders and org owners) sharing.',
	keywords: ['execution context', 'machine', 'status'],
	readOnly: true,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({ id: idSchema }),
	async handler(args, ctx) {
		return await getContextDetail(await caller(ctx), args.id)
	},
})

const grantPatchSchema = z
	.object({
		fs: z
			.array(z.object({ path: z.string().min(1), mode: z.enum(['ro', 'rw']) }))
			.max(32)
			.optional(),
		egress: z
			.object({
				mode: z.enum(['public', 'public-and-lan', 'allowlist', 'none']),
				hosts: z.array(z.string().min(1)).max(64).optional(),
				ports: z.array(z.number().int().min(1).max(65535)).max(32).optional(),
			})
			.optional(),
		credentials: z
			.union([
				z.object({ mode: z.literal('none') }),
				z.object({
					mode: z.literal('list'),
					ids: z.array(z.string().min(1)).max(64),
				}),
			])
			.optional(),
		runtime: z
			.union([
				z.object({ mode: z.literal('all') }),
				z.object({
					mode: z.literal('allowlist'),
					paths: z.array(z.string().min(1)).max(256),
				}),
			])
			.optional(),
		limits: z
			.object({
				timeoutMs: z
					.number()
					.int()
					.min(1000)
					.max(15 * 60_000)
					.optional(),
				memoryMb: z.number().int().min(64).max(8192).optional(),
				maxConcurrent: z.number().int().min(1).max(16).optional(),
			})
			.optional(),
	})
	.describe(
		'Server-side grant. The daemon intersects it with the machine local policy, so it can only narrow what the machine allows.',
	)

export const executionContextUpdateCapability = defineDomainCapability(domain, {
	name: 'executionContextUpdate',
	contextRuns: 'deny',
	orgPermission: 'execution_context:write',
	description:
		'Rename an execution context or change its grant (files, egress, credential allowlist, Kody API runtime allowlist, limits). Needs Contribute or Manage on it.',
	keywords: ['execution context', 'grant', 'rename'],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({
		id: idSchema,
		name: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
			.optional(),
		grant: grantPatchSchema.optional(),
	}),
	async handler(args, ctx) {
		return await updateContext(await caller(ctx), args.id, {
			...(args.name ? { name: args.name } : {}),
			...(args.grant ? { grant: args.grant as never } : {}),
		})
	},
})

export const executionContextRevokeCapability = defineDomainCapability(domain, {
	name: 'executionContextRevoke',
	contextRuns: 'deny',
	orgPermission: 'execution_context:delete',
	description:
		'Revoke an execution context: its key stops working, the daemon is disconnected, and in-flight runs are cancelled. In an attached org this detaches it instead.',
	keywords: ['execution context', 'revoke', 'delete'],
	readOnly: false,
	idempotent: true,
	destructive: true,
	inputSchema: z.object({ id: idSchema }),
	async handler(args, ctx) {
		return await revokeContext(await caller(ctx), args.id)
	},
})

export const executionContextOptInCapability = defineDomainCapability(domain, {
	name: 'executionContextOptIn',
	contextRuns: 'deny',
	orgPermission: 'execution_context:execute',
	description:
		'Opt into an execution context shared with you so your runs may execute on it. Read the returned notice: the operator can see the code, inputs, logs and results of your runs. Opting in does not add it to your chain.',
	keywords: ['execution context', 'opt in', 'join'],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({ id: idSchema }),
	async handler(args, ctx) {
		return await optIn(await caller(ctx), args.id)
	},
})

export const executionContextOptOutCapability = defineDomainCapability(domain, {
	name: 'executionContextOptOut',
	contextRuns: 'deny',
	orgPermission: 'execution_context:execute',
	description:
		'Leave an execution context: removes it from your chain and stops your runs on it. Returns your updated chain.',
	keywords: ['execution context', 'opt out', 'leave'],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({ id: idSchema }),
	async handler(args, ctx) {
		return await optOut(await caller(ctx), args.id)
	},
})

export const executionContextShareListCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextShareList',
		contextRuns: 'allow',
		orgPermission: 'execution_context:read',
		description:
			'List who an execution context is shared with in this org (people, teams, everyone in the org, attached orgs). For its operator, Manage holders and org owners.',
		keywords: ['execution context', 'sharing', 'collaborators'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({ id: idSchema }),
		async handler(args, ctx) {
			return await getSharing(await caller(ctx), args.id)
		},
	},
)

export const executionContextShareSetCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextShareSet',
		contextRuns: 'deny',
		orgPermission: 'execution_context:manage_access',
		description:
			'Share an execution context with a person (username or user_id, including outside collaborators), a team, or everyone in the org (all_members). People you share with run code on this machine after they opt in, and the operator sees their code, inputs, logs and results. Only the operator or a Manage holder may add.',
		keywords: ['execution context', 'share', 'grant'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			id: idSchema,
			username: z.string().min(1).optional(),
			user_id: z.string().min(1).optional(),
			team_slug: z.string().min(1).optional(),
			team_id: z.string().min(1).optional(),
			preset: z.enum(['use', 'contribute', 'manage']).default('use'),
			all_members: z.boolean().optional(),
		}),
		async handler(args, ctx) {
			const resolved = await caller(ctx)
			const add: Array<{
				subject: { type: 'user' | 'team'; id: string }
				preset: 'use' | 'contribute' | 'manage'
			}> = []
			if (args.team_slug || args.team_id) {
				add.push({
					subject: {
						type: 'team',
						id: await resolveTeamId(ctx.env.APP_DB, resolved.orgId, {
							teamId: args.team_id ?? null,
							teamSlug: args.team_slug ?? null,
						}),
					},
					preset: args.preset,
				})
			} else if (args.username || args.user_id) {
				add.push({
					subject: {
						type: 'user',
						id: await resolvePersonId(ctx.env.APP_DB, {
							userId: args.user_id ?? null,
							username: args.username ?? null,
						}),
					},
					preset: args.preset,
				})
			}
			return await setSharing(resolved, args.id, {
				add,
				...(args.all_members === undefined
					? {}
					: { allMembers: args.all_members }),
			})
		},
	},
)

export const executionContextShareRemoveCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextShareRemove',
		contextRuns: 'deny',
		orgPermission: 'execution_context:read',
		description:
			'Stop sharing an execution context with one grant holder. Their runs on the machine stop now. Org owners may remove shares too.',
		keywords: ['execution context', 'unshare', 'revoke share'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({ id: idSchema, grant_id: z.string().min(1) }),
		async handler(args, ctx) {
			return await removeShare(await caller(ctx), args.id, args.grant_id)
		},
	},
)

export const executionContextAttachCapability = defineDomainCapability(domain, {
	name: 'executionContextAttach',
	contextRuns: 'deny',
	orgPermission: 'execution_context:read',
	description:
		'Attach your execution context to another org you belong to, so it can be shared there. Operator only.',
	keywords: ['execution context', 'attach', 'org'],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({ id: idSchema, org_id: z.string().min(1) }),
	async handler(args, ctx) {
		return await attachContext(await caller(ctx), args.id, args.org_id)
	},
})

export const executionContextDetachCapability = defineDomainCapability(domain, {
	name: 'executionContextDetach',
	contextRuns: 'deny',
	orgPermission: 'execution_context:read',
	description:
		'Detach an execution context from an org: its shares and opt-ins there are removed and runs bound to that org stop.',
	keywords: ['execution context', 'detach', 'org'],
	readOnly: false,
	idempotent: true,
	destructive: true,
	inputSchema: z.object({ id: idSchema, org_id: z.string().min(1) }),
	async handler(args, ctx) {
		return await detachContext(await caller(ctx), args.id, args.org_id)
	},
})

export const executionContextRunListCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextRunList',
		contextRuns: 'allow',
		orgPermission: 'execution_context:read',
		description:
			'Run history of an execution context (who, when, duration, outcome, fallback), never results. Runs that started there and failed, were lost, or were cancelled keep failureReason (a code) and errorSummary (short error text). Managers see every requester in this org; others see their own runs. Kept 30 days.',
		keywords: ['execution context', 'runs', 'history'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			id: idSchema,
			cursor: z.coerce.number().int().optional(),
			limit: z.coerce.number().int().min(1).max(100).optional(),
			requester: z.string().min(1).optional(),
			outcome: z.string().min(1).optional(),
			since: z.coerce.number().int().optional(),
		}),
		async handler(args, ctx) {
			const { id, ...rest } = args
			return await listRuns(await caller(ctx), id, rest)
		},
	},
)

export const executionContextAuditListCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextAuditList',
		contextRuns: 'allow',
		orgPermission: 'execution_context:read',
		description:
			'Management audit log of an execution context (registration, grant changes, shares, opt-ins, revoke). For the operator, managers and org owners.',
		keywords: ['execution context', 'audit'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			id: idSchema,
			cursor: z.coerce.number().int().optional(),
			limit: z.coerce.number().int().min(1).max(100).optional(),
		}),
		async handler(args, ctx) {
			const { id, ...rest } = args
			return await listAudit(await caller(ctx), id, rest)
		},
	},
)

export const executionChainGetCapability = defineDomainCapability(domain, {
	name: 'executionChainGet',
	contextRuns: 'allow',
	orgPermission: 'execution_context:read',
	description:
		'Your execution chain in this org: the order Kody tries execution contexts for execute runs that do not name one, up to 3 contexts followed by Kody cloud (always last when present). Unusable entries stay listed with unusableReason and are skipped.',
	keywords: ['execution chain', 'fallback', 'order'],
	readOnly: true,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({}),
	async handler(_args, ctx) {
		return await chainResponse(await caller(ctx))
	},
})

export const executionChainSetCapability = defineDomainCapability(domain, {
	name: 'executionChainSet',
	contextRuns: 'deny',
	orgPermission: 'execution_context:execute',
	description:
		'Replace your execution chain. Send every entry in order ({kind:"context",id} or {kind:"cloud"}) and ifMatch set to the updatedAt you read (null for a chain never changed). Kody cloud, when present, must be the last entry (it is always available, so nothing after it would run); anything else is a 400. Leaving out cloud makes the chain strict: runs fail instead of falling back. 409 chain_changed returns the current chain.',
	keywords: ['execution chain', 'fallback', 'order', 'strict'],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({
		entries: z.array(chainEntrySchema).max(16),
		strict: z
			.boolean()
			.optional()
			.describe(
				'Informational; strict is derived from whether cloud is listed.',
			),
		ifMatch: z.string().nullable(),
	}),
	async handler(args, ctx) {
		return await setChain(await caller(ctx), {
			entries: args.entries,
			ifMatch: args.ifMatch,
		})
	},
})
