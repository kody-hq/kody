import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	resolvePersonId,
	resolveTeamId,
} from '#mcp/capabilities/access/shared.ts'
import {
	attachContext,
	cancelContextRun,
	chainResponse,
	daemonConfig,
	daemonLogs,
	daemonRestart,
	daemonStatus,
	daemonUpdate,
	pauseContext,
	resumeContext,
	detachContext,
	deleteContext,
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
import {
	dismissContextNotice,
	previewShare,
} from '#worker/execution-contexts/notices-service.ts'

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

export const grantPatchSchema = z
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
		commands: z
			.object({ enabled: z.boolean() })
			.optional()
			.describe(
				'Host commands (kody.command.*). Only `{ "enabled": false }` is accepted here: it turns commands off at once. Turning them on is a local action on the machine (`kody context commands on` or the desktop app), never an API call.',
			),
	})
	.loose()
	.refine((grant) => !('credentials' in grant), {
		message:
			"grant.credentials was removed: every run on a context uses its requester's credentials as it would in Kody cloud. Drop the credentials field.",
	})
	.describe(
		'Server-side grant. The daemon intersects it with the machine local policy (`kody context policy` on that machine), so it can only narrow what the machine allows. fs entries are absolute host folders with mode ro or rw; a folder is mounted at its real path only where both layers allow it, with the narrower mode, and the context offers `requires: ["fs"]` only while at least one folder is mounted.',
	)

export const executionContextUpdateCapability = defineDomainCapability(domain, {
	name: 'executionContextUpdate',
	contextRuns: 'deny',
	orgPermission: 'execution_context:write',
	description:
		"Rename an execution context or change its grant (files, egress, Kody API runtime allowlist, limits), or turn host commands off (`grant.commands.enabled: false`; turning them on happens only on the machine). Every run on a context uses its requester's credentials exactly as in Kody cloud (requests leave from Kody cloud, so values never reach the machine). Needs Contribute or Manage on it.",
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
		team_slug: z
			.string()
			.min(1)
			.nullable()
			.optional()
			.describe(
				'The team this machine is for (null clears). Grants nothing: Kody flags the machine when its login is not an agent profile assigned to that team. Needs Manage.',
			),
	}),
	async handler(args, ctx) {
		const resolved = await caller(ctx)
		const teamId =
			args.team_slug === undefined
				? undefined
				: args.team_slug === null
					? null
					: await resolveTeamId(ctx.env.APP_DB, resolved.orgId, {
							teamId: null,
							teamSlug: args.team_slug,
						})
		return await updateContext(resolved, args.id, {
			...(args.name ? { name: args.name } : {}),
			...(args.grant ? { grant: args.grant as never } : {}),
			...(teamId !== undefined ? { teamId } : {}),
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

export const executionContextDeleteCapability = defineDomainCapability(domain, {
	name: 'executionContextDelete',
	contextRuns: 'deny',
	orgPermission: 'execution_context:delete',
	description:
		'Permanently delete a revoked execution context so it no longer appears in executionContextList. Only works after executionContextRevoke; a context that is not revoked is refused. Removes its shares, opt-ins, org attachments and chain entries. Past runs keep the machine name in their run history. Pass the ec_ id, or the name when one revoked context has it.',
	keywords: [
		'execution context',
		'delete',
		'remove',
		'permanently delete',
		'clean up revoked machine',
	],
	readOnly: false,
	idempotent: false,
	destructive: true,
	inputSchema: z.object({ id: idSchema }),
	async handler(args, ctx) {
		return await deleteContext(await caller(ctx), args.id)
	},
})

export const executionContextOptInCapability = defineDomainCapability(domain, {
	name: 'executionContextOptIn',
	contextRuns: 'deny',
	orgPermission: 'execution_context:execute',
	description:
		"Join an execution context someone shared with you (to turn the execution contexts experiment on for your account, use experimentSet instead). Opting in is consent: the operator can see the code, inputs, logs and results of your runs, and while a run is active their machine can use your credentials (GitHub, email and others you've connected) and read the responses. Credential values stay in Kody cloud. Read the returned notice. Opting in does not add it to your chain.",
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
			'Share an execution context with a person (username or user_id, including outside collaborators), a team, or everyone in the org (all_members). People you share with run code on this machine after they opt in, with their own credentials; the operator sees their code, inputs, logs and results, including responses to their credentialed requests. Only the operator or a Manage holder may add.',
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
			commands: z
				.boolean()
				.optional()
				.describe(
					"Refused with commands_operator_only: host commands (kody.command.*) run only for the context's operator, so shares never include execution_context:command.",
				),
			all_members: z.boolean().optional(),
		}),
		async handler(args, ctx) {
			const resolved = await caller(ctx)
			const add: Array<{
				subject: { type: 'user' | 'team'; id: string }
				preset: 'use' | 'contribute' | 'manage'
				commands?: boolean
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
					...(args.commands ? { commands: true } : {}),
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
					...(args.commands ? { commands: true } : {}),
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
			'Run history of an execution context (who, when, duration, outcome, fallback, ranOn: { kind, id, name } where it ran, matching execute ranOn), never results. Runs that started there and failed, were lost, or were cancelled keep failureReason (a code) and errorSummary (short error text). Managers see every requester in this org; others see their own runs. Kept 30 days.',
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

export const executionContextRunCancelCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextRunCancel',
		contextRuns: 'deny',
		orgPermission: 'execution_context:execute',
		description:
			'Cancel a run on an execution context (a machine): a running run is stopped there and a queued one is dropped before it runs. The run ends cancelled with cancelReason "user_cancelled" in executionContextRunList and runGet. Pass the context (ec_ id or name) and the runId from execute or executionContextRunList. You can cancel your own runs; people who manage the context can cancel any run on it. A run that already ended returns cancelled: false with its state, so retrying is safe. Cloud runs cannot be cancelled. Ending the CLI or MCP call does not cancel a context run; use this.',
		keywords: [
			'execution context',
			'cancel run',
			'stop run',
			'kill run',
			'abort',
		],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			id: idSchema,
			run_id: z
				.string()
				.min(1)
				.max(200)
				.describe(
					'The runId to cancel (from execute or executionContextRunList).',
				),
		}),
		async handler(args, ctx) {
			return await cancelContextRun(await caller(ctx), args.id, args.run_id)
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

export const executionContextNoticeDismissCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextNoticeDismiss',
		contextRuns: 'deny',
		orgPermission: 'execution_context:read',
		description:
			'Dismiss your own excess-access notice on an execution context (the machine can do more than you can personally). Pass the fingerprint you saw; it comes back when the machine gains access you lack or its login changes. Misconfiguration notices cannot be dismissed. Only the person the notice is about can dismiss it, signed in as themselves.',
		keywords: ['execution context', 'notice', 'dismiss', 'warning'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			id: idSchema,
			fingerprint: z.string().min(1),
		}),
		async handler(args, ctx) {
			return await dismissContextNotice(
				await caller(ctx),
				args.id,
				args.fingerprint,
			)
		},
	},
)

export const executionContextSharePreviewCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextSharePreview',
		contextRuns: 'deny',
		orgPermission: 'execution_context:read',
		description:
			"Before sharing an execution context, see what its login (the machine's account or agent profile) can do that a person or each member of a team cannot do personally. Sharing is still allowed; this is the warning to review. Needs Manage on the context.",
		keywords: ['execution context', 'share', 'preview', 'excess access'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			id: idSchema,
			username: z.string().min(1).optional(),
			user_id: z.string().min(1).optional(),
			team_slug: z.string().min(1).optional(),
			team_id: z.string().min(1).optional(),
			all_members: z
				.boolean()
				.optional()
				.describe('Preview sharing with everyone in the org.'),
		}),
		async handler(args, ctx) {
			const resolved = await caller(ctx)
			const db = ctx.env.APP_DB
			let userIds: Array<string> = []
			if (args.all_members) {
				const members = await db
					.prepare(
						`SELECT user_id FROM org_memberships WHERE org_id = ? AND deleted_at IS NULL LIMIT 201`,
					)
					.bind(resolved.orgId)
					.all<{ user_id: string }>()
				userIds = members.results.map((row) => row.user_id)
			} else if (args.team_slug || args.team_id) {
				const teamId = await resolveTeamId(db, resolved.orgId, {
					teamId: args.team_id ?? null,
					teamSlug: args.team_slug ?? null,
				})
				const members = await db
					.prepare(
						`SELECT user_id FROM team_members WHERE team_id = ? AND deleted_at IS NULL`,
					)
					.bind(teamId)
					.all<{ user_id: string }>()
				userIds = members.results.map((row) => row.user_id)
			} else if (args.username || args.user_id) {
				userIds = [
					await resolvePersonId(db, {
						userId: args.user_id ?? null,
						username: args.username ?? null,
					}),
				]
			}
			return await previewShare(resolved, args.id, userIds)
		},
	},
)

const daemonContextRuns = 'deny' as const

export const executionContextPauseCapability = defineDomainCapability(domain, {
	name: 'executionContextPause',
	contextRuns: daemonContextRuns,
	orgPermission: 'execution_context:write',
	description:
		'Pause an execution context on the server (the remote "stop"): chains skip it ("was paused"), queued runs on it fail instead of waiting, and host commands are refused, until it is resumed. Holds while the machine is offline and across reboots; the daemon stays connected. Runs in flight finish unless cancel_runs is true. Needs the operator, Manage on it, or org owner/admin (a kill switch: admins can pause but not resume).',
	keywords: ['execution context', 'daemon', 'pause', 'stop', 'kill switch'],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({
		id: idSchema,
		reason: z
			.string()
			.max(200)
			.optional()
			.describe('Shown to anyone who sees the context, e.g. "deploy freeze".'),
		cancel_runs: z
			.boolean()
			.optional()
			.describe('Also cancel runs in flight (default: they finish).'),
	}),
	async handler(args, ctx) {
		return await pauseContext(await caller(ctx), args.id, {
			reason: args.reason ?? null,
			cancelRuns: args.cancel_runs === true,
		})
	},
})

export const executionContextResumeCapability = defineDomainCapability(domain, {
	name: 'executionContextResume',
	contextRuns: daemonContextRuns,
	orgPermission: 'execution_context:write',
	description:
		'Resume a paused execution context so routing sends it runs again. Needs the operator or Manage on it.',
	keywords: ['execution context', 'daemon', 'resume', 'unpause', 'start'],
	readOnly: false,
	idempotent: true,
	destructive: false,
	inputSchema: z.object({ id: idSchema }),
	async handler(args, ctx) {
		return await resumeContext(await caller(ctx), args.id)
	},
})

export const executionContextDaemonStatusCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextDaemonStatus',
		contextRuns: daemonContextRuns,
		orgPermission: 'execution_context:read',
		description:
			'Daemon status for an execution context: online / paused / offline / revoked, who paused it and why, and (for its operator, Manage holders and org owners/admins, when online) a live snapshot from the daemon: version, service manager, auto-update, concurrency, runs in flight and problems.',
		keywords: ['execution context', 'daemon', 'status', 'health', 'version'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({ id: idSchema }),
		async handler(args, ctx) {
			return await daemonStatus(await caller(ctx), args.id)
		},
	},
)

export const executionContextDaemonRestartCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextDaemonRestart',
		contextRuns: daemonContextRuns,
		orgPermission: 'execution_context:write',
		description:
			'Restart the daemon on an online execution context: it stops taking runs, lets runs in flight finish, and its service manager starts it again (it reconnects in a few seconds). Refused for a daemon run in a terminal, since nothing would start it again. Needs the operator or Manage on it.',
		keywords: ['execution context', 'daemon', 'restart'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({ id: idSchema }),
		async handler(args, ctx) {
			return await daemonRestart(await caller(ctx), args.id)
		},
	},
)

export const executionContextDaemonUpdateCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextDaemonUpdate',
		contextRuns: daemonContextRuns,
		orgPermission: 'execution_context:write',
		description:
			'Check now for a newer kody CLI on an online execution context and move the daemon onto it after runs in flight finish (the same verified path as auto-update). Reports the running and latest versions. Needs the operator or Manage on it.',
		keywords: ['execution context', 'daemon', 'update', 'version', 'upgrade'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({ id: idSchema }),
		async handler(args, ctx) {
			return await daemonUpdate(await caller(ctx), args.id)
		},
	},
)

export const executionContextDaemonConfigCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextDaemonConfig',
		contextRuns: daemonContextRuns,
		orgPermission: 'execution_context:write',
		description:
			'Change daemon config remotely: max_concurrent caps runs at once (a server limit, works while offline; the daemon uses the lower of it and its local setting) and auto_update turns automatic CLI updates on or off (needs the daemon online). Host folders and turning host commands on stay machine-side. Omit both to read the current values. Needs the operator or Manage on it.',
		keywords: [
			'execution context',
			'daemon',
			'config',
			'concurrency',
			'auto-update',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			id: idSchema,
			max_concurrent: z.number().int().min(1).max(8).optional(),
			auto_update: z.enum(['on', 'off']).optional(),
		}),
		async handler(args, ctx) {
			return await daemonConfig(await caller(ctx), args.id, {
				...(args.max_concurrent !== undefined
					? { maxConcurrent: args.max_concurrent }
					: {}),
				...(args.auto_update ? { autoUpdate: args.auto_update } : {}),
			})
		},
	},
)

export const executionContextDaemonLogsCapability = defineDomainCapability(
	domain,
	{
		name: 'executionContextDaemonLogs',
		contextRuns: daemonContextRuns,
		orgPermission: 'execution_context:command',
		description:
			"Read the last lines (default 100, at most 500) of an online execution context's daemon log. Operator only: the log can include host paths and command output. Every read is recorded in the context audit log.",
		keywords: ['execution context', 'daemon', 'logs', 'log', 'debug'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			id: idSchema,
			lines: z.number().int().min(1).max(500).optional(),
		}),
		async handler(args, ctx) {
			return await daemonLogs(await caller(ctx), args.id, {
				...(args.lines ? { lines: args.lines } : {}),
			})
		},
	},
)
