/**
 * soft-delete-read-filter: opt-out
 *
 * Offboarding soft-deletes memberships/grants and reads soft-deleted rows while
 * applying job dispositions. Live listing paths stay filtered elsewhere.
 */

import {
	automationToggleActor,
	recordToggleAudit,
} from '#worker/jobs/toggle-audit.ts'
import { offboardingDisabledReason } from '@kody-internal/shared/jobs/disabled-reason.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { deleteApprovalBundlesForMember } from '#worker/approval-bundles/repo.ts'
import { deleteCredentialProposalsForMember } from '#worker/credentials/agent-credential-proposals.ts'
import { deleteCredentialMappingsForMember } from '#worker/credentials/credential-mappings.ts'
import { deletePersonalCredentialOrgGrantsForMember } from '#worker/credentials/personal-credentials.ts'
import {
	listUserOAuthGrants,
	revokeOAuthGrant,
	type OAuthGrantHelpers,
	type OAuthGrantListItem,
} from '#worker/oauth-grants.ts'
import { jobAuditActions, recordJobAudit } from '#worker/jobs/job-audit.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { optionalOrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { wipePinnedConnectionsForMember } from '#worker/integrations/pinned-connections.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'

export type OffboardingJobDisposition = 'cancel' | 'delete' | 'keep_running'

export type OffboardingJobChoice = {
	jobId: string
	disposition: OffboardingJobDisposition
}

export type OffboardingResult = {
	membershipSoftDeleted: boolean
	teamMembershipsSoftDeleted: number
	grantsSoftDeleted: number
	budgetsSoftDeleted: number
	accessEpochBumped: boolean
	revokedOAuthGrants: number
	revokedApiTokens: number
	revokedCliBootstrapCodes: number
	disconnectedIntegrations: Array<string>
	disconnectedMcpServers: Array<string>
	jobDispositions: Array<OffboardingJobChoice>
}

export type OffboardingPreview = {
	jobs: Array<{ id: string; name: string }>
	ownLoginIntegrations: Array<string>
	ownLoginMcpServers: Array<string>
}

function jobCreatedByUserId(row: {
	user_id: string
	created_by_user_id?: string | null
}): string {
	const createdBy = row.created_by_user_id
	if (typeof createdBy === 'string' && createdBy.trim().length > 0) {
		return createdBy
	}
	return row.user_id
}

async function listMemberCreatedJobs(input: {
	env: Env
	orgId: OwnerId
	memberUserId: string
}): Promise<Array<{ id: string; name: string }>> {
	const jobsStore = jobsData(input.env)
	const allJobs = await jobsStore.listJobsForUser({ userId: input.orgId })
	return allJobs
		.filter(
			(row) =>
				jobCreatedByUserId({
					user_id: row.user_id,
					created_by_user_id: row.created_by_user_id,
				}) === input.memberUserId,
		)
		.map((row) => ({ id: row.id, name: row.name }))
}

function oauthGrantOrgId(
	grant: OAuthGrantListItem,
	memberUserId: string,
): string {
	const metadata = grant.metadata
	if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
		const orgId = (metadata as Record<string, unknown>)['orgId']
		if (typeof orgId === 'string' && orgId.trim().length > 0) {
			return orgId.trim()
		}
	}
	// Interim dual path (Teams §6.1): grants without metadata.orgId are treated
	// as bound to the member's personal/migrated org id (= userId). Cleanup
	// issue: revoke leftover grants lacking orgId after soak, then delete this
	// fallback.
	return memberUserId
}

/**
 * Revoke MCP OAuth grants for `memberUserId` that are bound to `orgId`.
 * Fail-closed: throws if listing or any revoke fails.
 */
export async function revokeOAuthGrantsForOrg(input: {
	helpers: OAuthGrantHelpers
	memberUserId: string
	orgId: OwnerId
}): Promise<number> {
	const grants = await listUserOAuthGrants(input.helpers, input.memberUserId)
	const matches = grants.filter(
		(grant) => oauthGrantOrgId(grant, input.memberUserId) === input.orgId,
	)
	let revoked = 0
	for (const grant of matches) {
		await revokeOAuthGrant(input.helpers, grant.id, input.memberUserId)
		revoked += 1
	}
	return revoked
}

export async function previewMemberOffboarding(input: {
	appDb: D1Database
	env: Env
	orgId: OwnerId
	memberUserId: string
}): Promise<OffboardingPreview> {
	const jobs = await listMemberCreatedJobs({
		env: input.env,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
	})

	const integrations = await input.appDb
		.prepare(
			`SELECT name FROM user_integrations
			 WHERE user_id = ? AND connected_by_user_id = ?${andLiveDeletedAtSql()}
			 ORDER BY name ASC`,
		)
		.bind(input.orgId, input.memberUserId)
		.all<{ name: string }>()

	const mcpServers = await input.appDb
		.prepare(
			`SELECT name FROM mcp_server_settings
			 WHERE user_id = ? AND connected_by_user_id = ?${andLiveDeletedAtSql()}
			 ORDER BY name ASC`,
		)
		.bind(input.orgId, input.memberUserId)
		.all<{ name: string }>()

	return {
		jobs,
		ownLoginIntegrations: (integrations.results ?? []).map((row) => row.name),
		ownLoginMcpServers: (mcpServers.results ?? []).map((row) => row.name),
	}
}

async function softDeleteMembershipGraph(input: {
	appDb: D1Database
	orgId: OwnerId
	memberUserId: string
	nowIso: string
	/**
	 * When set, a membership already tombstoned at this timestamp continues
	 * credential and integration cleanup instead of failing. A live last Owner
	 * still fails.
	 */
	resumeDeletedAt?: string
}): Promise<{
	membershipSoftDeleted: boolean
	teamMembershipsSoftDeleted: number
	grantsSoftDeleted: number
	budgetsSoftDeleted: number
	accessEpochBumped: boolean
}> {
	// One D1 batch (one transaction): the tombstone, the dependent cleanups
	// and the access_epoch bump commit together, so no reader can observe the
	// removed membership behind an epoch that still validates its cached role.
	// Cleanups and the bump only apply when the membership is tombstoned at
	// `nowIso` by this call or at `resumeDeletedAt` by an earlier one.
	const tombstonedAt = [input.nowIso, input.resumeDeletedAt ?? input.nowIso]
	const tombstonedMembershipSql = `EXISTS (
		     SELECT 1 FROM org_memberships
		     WHERE org_id = ? AND user_id = ? AND deleted_at IN (?, ?)
		   )`
	const tombstonedMembershipBindings = [
		input.orgId,
		input.memberUserId,
		...tombstonedAt,
	]
	const [membership, teamMembers, grants, budgets, epoch] =
		await input.appDb.batch([
			input.appDb
				.prepare(
					`UPDATE org_memberships
			 SET deleted_at = ?
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
			   AND (
			     role != 'owner'
			     OR (
			       SELECT COUNT(*) FROM org_memberships
			       WHERE org_id = ? AND role = 'owner' AND deleted_at IS NULL
			     ) > 1
			   )`,
				)
				.bind(input.nowIso, input.orgId, input.memberUserId, input.orgId),
			input.appDb
				.prepare(
					`UPDATE team_members
			 SET deleted_at = ?
			 WHERE user_id = ?
			   AND deleted_at IS NULL
			   AND team_id IN (
			     SELECT id FROM teams WHERE org_id = ?${andLiveDeletedAtSql()}
			   )
			   AND ${tombstonedMembershipSql}`,
				)
				.bind(
					input.nowIso,
					input.memberUserId,
					input.orgId,
					...tombstonedMembershipBindings,
				),
			input.appDb
				.prepare(
					`UPDATE grants
			 SET deleted_at = ?, updated_at = ?
			 WHERE org_id = ?
			   AND subject_type = 'user'
			   AND subject_id = ?
			   AND deleted_at IS NULL
			   AND ${tombstonedMembershipSql}`,
				)
				.bind(
					input.nowIso,
					input.nowIso,
					input.orgId,
					input.memberUserId,
					...tombstonedMembershipBindings,
				),
			input.appDb
				.prepare(
					`UPDATE org_user_budgets
			 SET deleted_at = ?
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL
			   AND ${tombstonedMembershipSql}`,
				)
				.bind(
					input.nowIso,
					input.orgId,
					input.memberUserId,
					...tombstonedMembershipBindings,
				),
			input.appDb
				.prepare(
					`UPDATE orgs
			 SET access_epoch = access_epoch + 1, updated_at = ?
			 WHERE id = ?${andLiveDeletedAtSql()}
			   AND ${tombstonedMembershipSql}`,
				)
				.bind(input.nowIso, input.orgId, ...tombstonedMembershipBindings),
		])
	const membershipSoftDeleted = (membership?.meta.changes ?? 0) > 0
	if (!membershipSoftDeleted) {
		const row = await input.appDb
			.prepare(
				`SELECT role, deleted_at FROM org_memberships
				 WHERE org_id = ? AND user_id = ?`,
			)
			.bind(input.orgId, input.memberUserId)
			.first<{ role: string; deleted_at: string | null }>()
		if (!row || row.deleted_at == null) {
			if (row?.role === 'owner') throw new Error('cannot_remove_last_owner')
			throw new Error('member_not_found')
		}
		if (row.deleted_at !== input.resumeDeletedAt) {
			throw new Error('member_not_found')
		}
	}

	return {
		membershipSoftDeleted,
		teamMembershipsSoftDeleted: teamMembers?.meta.changes ?? 0,
		grantsSoftDeleted: grants?.meta.changes ?? 0,
		budgetsSoftDeleted: budgets?.meta.changes ?? 0,
		accessEpochBumped: (epoch?.meta.changes ?? 0) > 0,
	}
}

async function disconnectOwnLoginIntegrations(input: {
	appDb: D1Database
	orgId: OwnerId
	memberUserId: string
	nowIso: string
}): Promise<{
	disconnectedIntegrations: Array<string>
	disconnectedMcpServers: Array<string>
}> {
	const integrationRows = await input.appDb
		.prepare(
			`SELECT name FROM user_integrations
			 WHERE user_id = ? AND connected_by_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId, input.memberUserId)
		.all<{ name: string }>()
	const disconnectedIntegrations = (integrationRows.results ?? []).map(
		(row) => row.name,
	)
	if (disconnectedIntegrations.length > 0) {
		await input.appDb
			.prepare(
				`UPDATE user_integrations
				 SET access_token_encrypted = NULL,
				     refresh_token_encrypted = NULL,
				     connected_at = NULL,
				     token_refreshed_at = NULL,
				     updated_at = ?
				 WHERE user_id = ?
				   AND connected_by_user_id = ?
				   AND deleted_at IS NULL`,
			)
			.bind(input.nowIso, input.orgId, input.memberUserId)
			.run()
	}

	const mcpRows = await input.appDb
		.prepare(
			`SELECT id, name FROM mcp_server_settings
			 WHERE user_id = ? AND connected_by_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.orgId, input.memberUserId)
		.all<{ id: string; name: string }>()
	const disconnectedMcpServers = (mcpRows.results ?? []).map((row) => row.name)
	if (disconnectedMcpServers.length > 0) {
		await input.appDb
			.prepare(
				`UPDATE mcp_server_settings
				 SET enabled = 0, updated_at = ?
				 WHERE user_id = ?
				   AND connected_by_user_id = ?
				   AND deleted_at IS NULL`,
			)
			.bind(input.nowIso, input.orgId, input.memberUserId)
			.run()
	}

	return { disconnectedIntegrations, disconnectedMcpServers }
}

async function revokeOrgBoundCredentials(input: {
	appDb: D1Database
	orgId: OwnerId
	memberUserId: string
	nowIso: string
	oauthHelpers: OAuthGrantHelpers | null
}): Promise<{
	revokedOAuthGrants: number
	revokedApiTokens: number
	revokedCliBootstrapCodes: number
}> {
	let revokedOAuthGrants = 0
	if (input.oauthHelpers) {
		revokedOAuthGrants = await revokeOAuthGrantsForOrg({
			helpers: input.oauthHelpers,
			memberUserId: input.memberUserId,
			orgId: input.orgId,
		})
	}

	// P4 stamps org_id on api_tokens and bootstrap codes. Revoke credentials
	// bound to this org for the removed member (personal org id == user id
	// still matches via org_id = memberUserId).
	let revokedApiTokens = 0
	let revokedCliBootstrapCodes = 0
	// Only org-bound tokens are revoked on leave. User-owned tokens
	// (`org_binding = 'user'`) stay; membership/grant checks deny the left org
	// on the next request.
	const tokenResult = await input.appDb
		.prepare(
			`UPDATE api_tokens
			 SET revoked_at = ?, updated_at = ?
			 WHERE user_id = ?
			   AND org_binding = 'org'
			   AND COALESCE(org_id, user_id) = ?
			   AND revoked_at IS NULL
			   AND deleted_at IS NULL`,
		)
		.bind(input.nowIso, input.nowIso, input.memberUserId, input.orgId)
		.run()
	revokedApiTokens = tokenResult.meta.changes ?? 0

	const bootstrap = await input.appDb
		.prepare(
			`DELETE FROM cli_credential_bootstrap_codes
			 WHERE user_id = ?
			   AND org_binding = 'org'
			   AND COALESCE(org_id, user_id) = ?`,
		)
		.bind(input.memberUserId, input.orgId)
		.run()
	revokedCliBootstrapCodes = bootstrap.meta.changes ?? 0

	return {
		revokedOAuthGrants,
		revokedApiTokens,
		revokedCliBootstrapCodes,
	}
}

async function applyJobDispositions(input: {
	env: Env
	orgId: OwnerId
	memberUserId: string
	choices: Array<OffboardingJobChoice>
	nowIso: string
	memberLeftVoluntarily: boolean
}): Promise<Array<OffboardingJobChoice>> {
	if (input.memberLeftVoluntarily) {
		// Spec §9 step 4: when a member leaves on their own, jobs keep running.
		return []
	}
	const jobsStore = jobsData(input.env)
	const applied: Array<OffboardingJobChoice> = []
	for (const choice of input.choices) {
		const job = await jobsStore.getJobById({
			userId: input.orgId,
			jobId: choice.jobId,
		})
		if (!job) continue
		const createdBy = jobCreatedByUserId({
			user_id: job.user_id,
			created_by_user_id: job.created_by_user_id,
		})
		if (createdBy !== input.memberUserId) continue
		switch (choice.disposition) {
			case 'keep_running':
				applied.push(choice)
				break
			case 'cancel': {
				const updated = {
					...job.record,
					enabled: false,
					disabledReason: job.record.enabled
						? offboardingDisabledReason
						: job.record.disabledReason,
					updatedAt: input.nowIso,
				}
				await jobsStore.updateJob({
					userId: input.orgId,
					job: updated,
					callerContextJson: job.callerContextJson,
				})
				if (job.record.enabled) {
					await recordToggleAudit({
						env: input.env,
						orgId: input.orgId,
						resource: 'job',
						resourceId: job.record.id,
						name: job.record.name,
						from: 'on',
						to: 'off',
						source: 'offboarding',
						actor: automationToggleActor(),
						reason: offboardingDisabledReason,
					})
				}
				applied.push(choice)
				break
			}
			case 'delete': {
				await jobsStore.deleteJob({
					userId: input.orgId,
					jobId: choice.jobId,
				})
				await recordJobAudit(optionalOrgAuditWriter(input.env, null), {
					orgId: input.orgId,
					jobId: job.record.id,
					name: job.record.name,
					action: jobAuditActions.deleted,
				})
				applied.push(choice)
				break
			}
			default: {
				const exhaustive: never = choice.disposition
				throw new Error(`Unhandled job disposition: ${String(exhaustive)}`)
			}
		}
	}
	await syncJobManagerAlarm({ env: input.env, userId: input.orgId })
	return applied
}

/**
 * Remove a member from an org (or complete leave): soft-delete access rows,
 * revoke org-bound credentials, disconnect own-login integrations, and apply
 * job dispositions when an Owner removes them.
 */
export async function offboardOrgMember(input: {
	appDb: D1Database
	env: Env
	orgId: OwnerId
	memberUserId: string
	/** When true, jobs keep running and Owners are expected to decide later. */
	memberLeftVoluntarily: boolean
	jobChoices?: Array<OffboardingJobChoice>
	oauthHelpers?: OAuthGrantHelpers | null
	now?: Date
	/**
	 * Continue when this membership was already tombstoned at `now` (a retry
	 * of the same removal). Omit it to fail if the member is already gone.
	 */
	resumeDeletedAt?: string
}): Promise<OffboardingResult> {
	const nowIso = (input.now ?? new Date()).toISOString()

	const graph = await softDeleteMembershipGraph({
		appDb: input.appDb,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
		nowIso,
		resumeDeletedAt: input.resumeDeletedAt,
	})

	// Connections pinned to this org's OAuth apps end with the binding. A
	// failure here must not skip the token revocations below; it is rethrown
	// once they ran so the removal can be retried.
	let pinnedWipeError: unknown = null
	try {
		await wipePinnedConnectionsForMember({
			env: input.env,
			orgId: input.orgId,
			personId: input.memberUserId,
			audit: optionalOrgAuditWriter(input.env, null),
		})
	} catch (error) {
		pinnedWipeError = error
	}
	await deletePersonalCredentialOrgGrantsForMember({
		db: input.appDb,
		orgId: input.orgId,
		personId: input.memberUserId,
	})
	await deleteCredentialMappingsForMember({
		db: input.appDb,
		orgId: input.orgId,
		personId: input.memberUserId,
	})
	await deleteCredentialProposalsForMember({
		db: input.appDb,
		orgId: input.orgId,
		personId: input.memberUserId,
	})
	await deleteApprovalBundlesForMember({
		db: input.appDb,
		orgId: input.orgId,
		personId: input.memberUserId,
	})

	const credentials = await revokeOrgBoundCredentials({
		appDb: input.appDb,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
		nowIso,
		oauthHelpers: input.oauthHelpers ?? null,
	})

	const disconnected = await disconnectOwnLoginIntegrations({
		appDb: input.appDb,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
		nowIso,
	})

	const jobDispositions = await applyJobDispositions({
		env: input.env,
		orgId: input.orgId,
		memberUserId: input.memberUserId,
		choices: input.jobChoices ?? [],
		nowIso,
		memberLeftVoluntarily: input.memberLeftVoluntarily,
	})
	if (pinnedWipeError) throw pinnedWipeError

	return {
		...graph,
		...credentials,
		...disconnected,
		jobDispositions,
	}
}
