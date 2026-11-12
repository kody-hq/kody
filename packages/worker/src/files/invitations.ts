import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import {
	inviteAcceptCapability,
	inviteMatchesUser,
} from '#mcp/capabilities/access/invites.ts'
import { hashInviteToken } from '#mcp/capabilities/access/shared.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getInviteByTokenHash } from '#worker/orgs/access-writes.ts'
import { getOrgById, isOrgActive } from '#worker/orgs/repo.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { fileStoreRpc } from './client.ts'

export async function fileInvitationOffer(
	ctx: CapabilityContext,
	token: string,
) {
	const user = requireMcpUser(ctx.callerContext)
	const invite = await getInviteByTokenHash(
		ctx.env.APP_DB,
		await hashInviteToken(token),
	)
	const unavailable = {
		ok: false as const,
		message:
			'This invitation is unavailable for this account. Sign in with the email address it was shared with.',
	}
	if (
		!invite ||
		invite.kind !== 'grant' ||
		invite.resourceType !== 'file' ||
		!invite.resourceId ||
		!inviteMatchesUser(invite, user)
	)
		return unavailable
	if (invite.status !== 'pending' && invite.status !== 'accepted')
		return unavailable
	if (
		invite.status === 'pending' &&
		(!Number.isFinite(Date.parse(invite.expiresAt)) ||
			Date.parse(invite.expiresAt) <= Date.now())
	)
		return unavailable
	const org = await getOrgById(ctx.env.APP_DB, invite.orgId)
	if (!org?.slug || !(await isOrgActive(ctx.env.APP_DB, org.id)))
		return unavailable
	const owner = ownerIdFromStored(org.id)
	const file = await fileStoreRpc(ctx.env, owner).metadata(
		owner,
		invite.resourceId,
	)
	if (!file?.revisionId || file.trashedAt) return unavailable
	return {
		ok: true as const,
		name: file.name,
		orgSlug: org.slug,
		preset: invite.preset,
		accepted: invite.status === 'accepted',
		href: `/@${encodeURIComponent(org.slug)}/-/files?file=${encodeURIComponent(file.id)}`,
	}
}
export async function acceptFileInvitation(
	ctx: CapabilityContext,
	token: string,
) {
	requireMcpRequest(ctx.callerContext)
	const offer = await fileInvitationOffer(ctx, token)
	if (!offer.ok) throw new McpCallerError(offer.message)
	if (!offer.accepted) await inviteAcceptCapability.handler({ token }, ctx)
	return { href: offer.href }
}
