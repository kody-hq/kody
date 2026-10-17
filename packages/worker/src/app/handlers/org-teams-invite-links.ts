import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { personalOrgTeamWriteResponse } from '#app/handlers/org-teams.ts'
import {
	inviteLinkUrl,
	readInviteLinkOptions,
} from '#app/invite-link-options.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
} from '#app/org-management-access.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	createOrgInviteLink,
	generateInviteLinkToken,
	hashInviteLinkToken,
	revokeOrgInviteLink,
} from '#worker/orgs/invite-links.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'

/**
 * Team links add the person to the org (as Member when they are not one yet)
 * and to one team, so managing them takes both team:write and member:write.
 */
async function resolveTeamLinkAccess(
	request: Request,
	env: Env,
	user: InviteOperationContext['user'],
	orgSlug: string,
) {
	const access = await resolveOrgManagementAccess({
		request,
		env,
		user,
		permission: 'team:write',
		orgSlug,
	})
	if (!access.ok) {
		return {
			ok: false as const,
			response: operationResult(
				{ ok: false, error: access.error },
				access.status,
			),
		}
	}
	if (access.org.personal) {
		return { ok: false as const, response: personalOrgTeamWriteResponse() }
	}
	if (!(await orgHasPermission(env, user, 'member:write'))) {
		return {
			ok: false as const,
			response: operationResult(
				{
					ok: false,
					error:
						'Team links also add people to the organization, so they need permission to manage members.',
				},
				403,
			),
		}
	}
	return { ok: true as const, user, org: access.org }
}

export async function createTeamInviteLink({
	env,
	request,
	user,
	orgSlug,
	...fields
}: InviteOperationContext & {
	orgSlug: string
	teamId?: string
	linkId?: string
	maxUses?: string | number | null
	expiresInDays?: string | number | null
	allowedEmailDomains?: string | string[]
}) {
	const access = await resolveTeamLinkAccess(request, env, user, orgSlug)
	if (!access.ok) return access.response
	const { org } = access
	const body = fields
	const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : ''
	if (!teamId) {
		return operationResult({ ok: false, error: 'Choose a team.' }, 400)
	}
	const parsedOptions = readInviteLinkOptions(body)
	if (!parsedOptions.ok) {
		return operationResult({ ok: false, error: parsedOptions.error }, 400)
	}
	const { allowedEmailDomains, maxUses, expiresAt } = parsedOptions.options
	const token = generateInviteLinkToken()
	const tokenHash = await hashInviteLinkToken(token)
	try {
		const created = await createOrgInviteLink({
			db: env.APP_DB,
			orgId: org.id,
			target: { kind: 'team', teamId },
			createdByUserId: user.mcpUser.userId,
			tokenHash,
			allowedEmailDomains,
			maxUses,
			expiresAt,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
		return operationResult({
			ok: true,
			inviteLink: {
				id: created.id,
				teamId,
				expiresAt: created.expiresAt,
				maxUses: created.maxUses,
				url: inviteLinkUrl(request, token),
			},
		})
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to create that invite link.',
			},
			400,
		)
	}
}

export async function revokeTeamInviteLink({
	env,
	request,
	user,
	orgSlug,
	...fields
}: InviteOperationContext & {
	orgSlug: string
	teamId?: string
	linkId?: string
	maxUses?: string | number | null
	expiresInDays?: string | number | null
	allowedEmailDomains?: string | string[]
}) {
	const access = await resolveTeamLinkAccess(request, env, user, orgSlug)
	if (!access.ok) return access.response
	const { org } = access
	const body = fields
	const linkId = typeof body?.linkId === 'string' ? body.linkId.trim() : ''
	if (!linkId) {
		return operationResult(
			{ ok: false, error: 'An invite link is required.' },
			400,
		)
	}
	try {
		await revokeOrgInviteLink({
			db: env.APP_DB,
			orgId: org.id,
			linkId,
			scope: { kind: 'team' },
			audit: orgAuditWriterFromRequest(env, user.request),
		})
	} catch (error) {
		return operationResult(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to revoke that invite link.',
			},
			400,
		)
	}
	return operationResult({ ok: true, revokedLinkId: linkId })
}

type InviteOperationContext = {
	env: Env
	request: Request
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
}
