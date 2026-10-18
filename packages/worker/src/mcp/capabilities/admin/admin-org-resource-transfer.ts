import { z } from 'zod'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	orgTransferSteps,
	runOrgResourceTransfer,
} from '#worker/org-transfer/apply.ts'
import { orgTransferMemoriesStayNote } from '#worker/org-transfer/report.ts'
import { defaultOrgTransferEffects } from '#worker/org-transfer/effects.ts'
import { orgTransferFindingCodes } from '#worker/org-transfer/findings.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const orgSchema = z.object({ id: z.string(), slug: z.string() })
const entryNameSchema = z.object({
	scope: z.string(),
	binding: z.string(),
	name: z.string(),
})
const findingSchema = z.object({
	code: z.enum(orgTransferFindingCodes),
	message: z.string(),
	table: z.string().optional(),
	subject: z.string().optional(),
})

export const adminOrgResourceTransferCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminOrgResourceTransfer',
		description:
			'Admin-only: move every live resource of one org (packages, repos, sources, secrets, integrations, OAuth apps, MCP servers, webhooks, package storage, package jobs, enablements) to another org. Memories (personal-only), email inboxes, usage history, run logs, billing, and the meter stay. dry-run reports the plan as counts and names, with coded clashes, blockers, warnings, and orphans, kept.memories (live memories that stay with their owner), the refusals apply would raise, and a plan fingerprint. apply returns outcome refused (with refusals) on any clash or blocker, on orphans unless skipOrphans (which leaves orphans out and deletes them), and when expectedFingerprint no longer matches the plan. A failure before commit returns outcome failed with { committed: false, failed_step, failed_undo?, backup_key } and moves nothing. apply holds both orgs\u2019 write leases, writes an R2 backup of every touched row, re-seals credentials to the target, copies package storage, re-points everything in one D1 batch (package names become @<target>/<kody_id>), bumps both access epochs, and writes org audit events on both. Returns counts, names, the backup key, per-server MCP connection state with the Kody authorize URL when approval is pending, and each webhook\u2019s old and new public path prefix (without the URL secret); never credential values. Follow with the owner-scope-follows-registry codemod so package sources import the new scope. Audited.',
		keywords: [
			'admin',
			'org',
			'transfer',
			'move resources',
			'team',
			'migration',
		],
		destructive: true,
		inputSchema: z.object({
			fromOrgId: z.string().min(1).describe('Source org id (orgs.id).'),
			toOrgId: z.string().min(1).describe('Target org id (orgs.id).'),
			mode: z
				.enum(['dry-run', 'apply'])
				.describe('dry-run writes nothing; apply moves.'),
			skipOrphans: z
				.boolean()
				.optional()
				.describe(
					'Leave rows whose parent no longer exists out of the move and delete them.',
				),
			expectedFingerprint: z
				.string()
				.min(1)
				.optional()
				.describe(
					'The fingerprint from a reviewed dry-run. apply refuses (plan_drifted) if the plan changed since.',
				),
		}),
		outputSchema: z.object({
			mode: z.enum(['dry-run', 'apply']),
			outcome: z.enum(['planned', 'refused', 'failed', 'applied']),
			applied: z.boolean(),
			fingerprint: z.string(),
			from: orgSchema,
			to: orgSchema,
			counts: z.record(z.string(), z.number()),
			packages: z.array(
				z.object({
					id: z.string(),
					from_name: z.string(),
					to_name: z.string(),
				}),
			),
			repos: z.array(z.string()),
			secrets: z.array(entryNameSchema),
			integrations: z.array(z.string()),
			oauth_apps: z.array(z.string()),
			mcp_servers: z.array(z.object({ id: z.string(), name: z.string() })),
			webhooks: z.array(
				z.object({
					package: z.string(),
					name: z.string(),
					url_changed: z.literal(true),
					old_path_prefix: z.string(),
					new_path_prefix: z.string(),
					manage_path: z.string(),
				}),
			),
			enablements: z.array(
				z.object({
					package: z.string(),
					trigger_kind: z.string(),
					trigger_name: z.string(),
					state: z.string(),
					enabler_user_id: z.string(),
					enabler_is_target_member: z.boolean(),
				}),
			),
			jobs: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					package: z.string(),
					schedule: z.string(),
				}),
			),
			storages: z.array(z.object({ storage_id: z.string(), kind: z.string() })),
			orphans: z.array(
				z.object({ table: z.string(), key: z.string(), reason: z.string() }),
			),
			clashes: z.array(findingSchema),
			blockers: z.array(findingSchema),
			warnings: z.array(findingSchema),
			kept: z.object({
				memories: z.object({
					count: z.number().int().nonnegative(),
					note: z.literal(orgTransferMemoriesStayNote),
				}),
			}),
			refusals: z.array(findingSchema),
			failure: z
				.object({
					committed: z.literal(false),
					failed_step: z.enum(orgTransferSteps),
					failed_undo: z.array(z.string()).optional(),
					backup_key: z.string().nullable(),
					message: z.string(),
				})
				.nullable(),
			backup_key: z.string().nullable(),
			storage_copies: z.array(
				z.object({
					storage_id: z.string(),
					kv_entries: z.number(),
					sql_rows: z.record(z.string(), z.number()),
				}),
			),
			leftovers: z.record(z.string(), z.number()),
			post_commit_warnings: z.array(findingSchema),
			mcp_connections: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					source_removed: z.boolean(),
					state: z.string().nullable(),
					needs_authorization: z.boolean(),
					authorize_url: z.string().nullable(),
				}),
			),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminOrgResourceTransfer',
				async () => {
					const actor = ctx.callerContext.user
					if (!actor) throw new Error('A signed-in admin is required.')
					const baseUrl = getAppBaseUrl({
						env: ctx.env,
						requestUrl: ctx.callerContext.baseUrl,
					})
					const result = await runOrgResourceTransfer({
						db: ctx.env.APP_DB,
						effects: defaultOrgTransferEffects({
							env: ctx.env,
							baseUrl,
							actor: {
								userId: actor.userId,
								username: actor.username ?? null,
							},
						}),
						actorUserId: actor.userId,
						fromOrgId: args.fromOrgId,
						toOrgId: args.toOrgId,
						mode: args.mode,
						skipOrphans: args.skipOrphans ?? false,
						expectedFingerprint: args.expectedFingerprint,
					})
					return {
						mode: result.mode,
						outcome: result.outcome,
						applied: result.applied,
						fingerprint: result.fingerprint,
						...result.summary,
						refusals: result.refusals,
						failure: result.failure,
						backup_key: result.backupKey,
						storage_copies: result.storage.map((copy) => ({
							storage_id: copy.storageId,
							kv_entries: copy.kvEntries,
							sql_rows: copy.sqlRows,
						})),
						leftovers: result.leftovers,
						post_commit_warnings: result.postCommitWarnings,
						mcp_connections: result.mcpConnections,
					}
				},
				{
					resultOf: (result) =>
						result.outcome === 'refused' || result.outcome === 'failed'
							? 'failure'
							: 'success',
					successReason: (result) =>
						`mode=${result.mode};outcome=${result.outcome};${result.failure ? `failed_step=${result.failure.failed_step};failed_undo=${result.failure.failed_undo?.join(',') ?? 'none'};` : ''}fingerprint=${result.fingerprint};from=${result.from.id};to=${result.to.id};packages=${result.packages.length};orphans=${result.orphans.length};clashes=${result.clashes.length};blockers=${result.blockers.length};refusals=${result.refusals.map((finding) => finding.code).join(',')};backup=${result.backup_key ?? 'none'}`,
				},
			)
		},
	},
)
