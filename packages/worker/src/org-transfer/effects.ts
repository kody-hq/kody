import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import {
	createPackageJobCallerContext,
	serializeCallerContext,
} from '#worker/jobs/service.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { mcpClientHubTransferStub } from '#worker/mcp-client/hub-transfer.ts'
import { orgAuditWriterForPerson } from '#worker/orgs/org-audit.ts'
import {
	commitOrgAuditOutbox,
	orgAuditOutboxInsertStatement,
	planOrgAuditOutbox,
} from '#worker/orgs/org-audit-outbox.ts'
import {
	listPinnedConnectionsForOrg,
	planPinnedConnectionWipes,
} from '#worker/integrations/pinned-connections.ts'
import { type OrgTransferEffects } from './apply.ts'
import { writeOrgTransferBackup } from './backup.ts'
import { runOrgTransferPostCommit } from './post-commit.ts'
import { resealOrgTransferSecrets } from './reencrypt.ts'
import { loadOrgTransferSnapshot } from './snapshot.ts'
import {
	clearOwnerStorage,
	copyOwnerStorage,
	isOwnerStorageEmpty,
} from './storage-copy.ts'

export function defaultOrgTransferEffects(input: {
	env: Env
	baseUrl: string
	actor: { userId: string; username: string | null }
}): OrgTransferEffects {
	const { env, baseUrl } = input
	return {
		withWriteLease: (ownerId, write) =>
			withAccountWriteLease({
				db: env.APP_DB,
				env,
				stableUserId: ownerId,
				holder: 'admin-org-resource-transfer',
				write,
			}),
		loadSnapshot: ({ from, to }) => loadOrgTransferSnapshot({ env, from, to }),
		reseal: (plan) => resealOrgTransferSecrets({ env, plan }),
		async writeBackup({ key, backup }) {
			const bucket = env.OPERATOR_BACKUPS
			if (!bucket) {
				throw new Error('OPERATOR_BACKUPS is not bound; refusing to apply.')
			}
			await writeOrgTransferBackup({ bucket, key, backup })
		},
		async copyLogo(copy) {
			const object = await env.COMMUNITY_ASSETS.get(copy.fromKey)
			if (!object) throw new Error(`Logo ${copy.fromKey} was not found.`)
			await env.COMMUNITY_ASSETS.put(copy.toKey, await object.arrayBuffer(), {
				httpMetadata: object.httpMetadata,
			})
		},
		deleteLogo: (key) => env.COMMUNITY_ASSETS.delete(key),
		isStorageEmpty: ({ userId, storageId }) =>
			isOwnerStorageEmpty({ env, userId, storageId }),
		copyStorage: (copy) => copyOwnerStorage({ env, ...copy }),
		clearStorage: ({ userId, storageId }) =>
			clearOwnerStorage({ env, userId, storageId }),
		exportMcpServer: ({ userId, serverId }) =>
			mcpClientHubTransferStub({ env, userId }).exportServerForTransfer({
				serverId,
			}),
		importMcpServer: ({ userId, transfer }) =>
			mcpClientHubTransferStub({ env, userId }).importServerForTransfer(
				transfer,
			),
		discardMcpServerImport: ({ userId, serverId }) =>
			mcpClientHubTransferStub({ env, userId }).discardTransferredServer({
				serverId,
			}),
		async planPinnedMemberWipes({ orgId, appSlugs }) {
			const connections = []
			for (const appSlug of appSlugs) {
				connections.push(
					...(await listPinnedConnectionsForOrg({
						db: env.APP_DB,
						pinnedOrgId: orgId,
						appSlug,
					})),
				)
			}
			return planPinnedConnectionWipes({
				env,
				connections,
				reason: 'app_deleted',
				audit: orgAuditWriterForPerson(env, input.actor),
			})
		},
		async jobCallerContextJson({ userId, packageId }) {
			return serializeCallerContext(
				await createPackageJobCallerContext({
					env,
					db: env.APP_DB,
					baseUrl,
					userId,
					packageId,
				}),
			)
		},
		transferJobs: (transfer) => jobsData(env).transferJobsOwner(transfer),
		planAudit(events) {
			const writer = orgAuditWriterForPerson(env, input.actor)
			const plans = events.map((event) =>
				planOrgAuditOutbox(writer, {
					orgId: event.orgId,
					action: event.action,
					resourceType: 'org',
					resourceId: event.orgId,
					details: event.details,
				}),
			)
			return {
				statements: plans.map((plan) =>
					orgAuditOutboxInsertStatement(env.APP_DB, plan),
				),
				async deliver() {
					for (const plan of plans) await commitOrgAuditOutbox(writer, plan)
				},
			}
		},
		afterCommit: ({ plan, cleanupOrphans }) =>
			runOrgTransferPostCommit({ env, baseUrl, plan, cleanupOrphans }),
	}
}
