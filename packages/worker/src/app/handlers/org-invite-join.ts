import {
	readAuthenticatedAppUser,
	type AuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import {
	checkRateLimit,
	orgInviteJoinRateLimitConfig,
	releaseRateLimit,
} from '#app/rate-limit.ts'
import { operationResult } from '#app/operation-result.ts'
import { buildOrgAvatarUrl } from '#worker/orgs/org-avatar.ts'
import {
	clearInviteLinkPending,
	getPendingInviteLinkForPerson,
	recordInviteLinkPending,
} from '#worker/orgs/invite-link-pending.ts'
import {
	hasRedeemedInviteLink,
	inviteLinkAlreadySatisfied,
	inviteLinkCreatorStillValid,
	inviteLinkTargetBlock,
	type InviteLinkTargetBlockReason,
	redeemOrgInviteLink,
} from '#worker/orgs/invite-link-redeem.ts'
import {
	getInviteLinkByTokenHash,
	hashInviteLinkToken,
	inviteLinkBlockMessage,
	type InviteLinkRedeemBlockReason,
	type InviteLinkTarget,
	type StoredInviteLink,
} from '#worker/orgs/invite-links.ts'
import { getLiveOrgMembership } from '#worker/orgs/org-members-list.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	type OrgInviteJoinLoaderData,
	type OrgInviteJoinOffer,
} from '#universal/loader-data.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
import {
	packageCollaboratorPresetDescription,
	packageCollaboratorPresetLabel,
} from '#universal/package-collaborators.ts'
import { routes } from '#universal/routes.ts'

function joinRateLimitKey(request: Request, key: string) {
	const ip = getRequestIp(request) ?? 'unknown'
	const keyPrefix = key.slice(0, 8) || 'missing'
	return `org-invite-join:${ip}:${keyPrefix}`
}

async function readTeamName(db: D1Database, orgId: string, teamId: string) {
	const row = await db
		.prepare(
			`SELECT name FROM teams
			 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
		)
		.bind(teamId, orgId)
		.first<{ name: string }>()
	return row?.name ?? null
}

async function readPackageNames(
	db: D1Database,
	orgId: string,
	packageId: string,
) {
	return await db
		.prepare(
			`SELECT name, kody_id FROM saved_packages
			 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(packageId, orgId)
		.first<{ name: string; kody_id: string }>()
}

async function readCreatorLabel(db: D1Database, userId: string) {
	const row = await db
		.prepare(
			`SELECT username, display_name FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(userId)
		.first<{ username: string | null; display_name: string | null }>()
	if (row?.display_name?.trim()) return row.display_name.trim()
	return row?.username ? `@${row.username}` : null
}

async function buildOffer(input: {
	db: D1Database
	link: StoredInviteLink
	orgSlug: string
	isMember: boolean
}): Promise<OrgInviteJoinOffer | null> {
	const target = input.link.target
	switch (target.kind) {
		case 'membership':
			return {
				kind: 'membership',
				role: target.role,
				roleLabel: orgRoleLabel(target.role),
			}
		case 'team': {
			const teamName = await readTeamName(
				input.db,
				input.link.orgId,
				target.teamId,
			)
			if (!teamName) return null
			return { kind: 'team', teamName, joinsOrg: !input.isMember }
		}
		case 'resource': {
			const pkg = await readPackageNames(
				input.db,
				input.link.orgId,
				target.resourceId,
			)
			if (!pkg) return null
			return {
				kind: 'resource',
				packageName: pkg.name,
				packageHref: routes.communityPackage.href({
					username: input.orgSlug,
					kodyId: pkg.kody_id,
				}),
				preset: target.preset,
				presetLabel: packageCollaboratorPresetLabel(target.preset),
				presetDescription: packageCollaboratorPresetDescription(target.preset),
				outsideCollaborator: !input.isMember,
			}
		}
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

function failure(
	reason: Extract<OrgInviteJoinLoaderData, { ok: false }>['reason'],
	error?: string,
): OrgInviteJoinLoaderData {
	return {
		ok: false,
		reason,
		error:
			error ??
			(reason === 'missing'
				? 'Invite link token is required.'
				: inviteLinkBlockMessage(reason)),
	}
}

/**
 * A team or package link that stopped working can still be settled for the
 * viewer: they already hold what it gives (show that), or they spent it
 * themselves (say so instead of a generic "used up"). Membership links keep
 * reporting the block itself.
 */
async function settledBlockedLinkForViewer(
	db: D1Database,
	link: StoredInviteLink,
	block: InviteLinkTargetBlockReason,
	viewerId: string,
): Promise<'satisfied' | 'already_used' | null> {
	if (link.target.kind === 'membership') return null
	if (block !== 'exhausted' && block !== 'expired' && block !== 'revoked') {
		return null
	}
	if (await inviteLinkAlreadySatisfied(db, link, viewerId)) return 'satisfied'
	if (await hasRedeemedInviteLink(db, link.id, viewerId)) return 'already_used'
	return null
}

/**
 * The accept page for one link. Viewing it never applies the link; a
 * signed-in viewer who still needs what it gives gets a pending row so the
 * invite also waits on their Organizations page.
 */
export async function loadJoinPageData(input: {
	env: Env
	request: Request
	token: string
}): Promise<OrgInviteJoinLoaderData> {
	const db = input.env.APP_DB
	const token = input.token.trim()
	if (!token) return failure('missing')
	const tokenHash = await hashInviteLinkToken(token)
	const link = await getInviteLinkByTokenHash(db, tokenHash)
	if (!link) return failure('invalid')
	const user = await readAuthenticatedAppUser(input.request, input.env)
	const viewerId = user?.mcpUser.userId ?? null
	const block = await inviteLinkTargetBlock(db, link)
	if (block) {
		const settled = viewerId
			? await settledBlockedLinkForViewer(db, link, block, viewerId)
			: null
		if (settled !== 'satisfied') return failure(settled ?? block)
	}
	if (
		link.target.kind !== 'membership' &&
		!(await inviteLinkCreatorStillValid(db, link)) &&
		!(viewerId && (await inviteLinkAlreadySatisfied(db, link, viewerId)))
	) {
		if (viewerId) {
			await clearInviteLinkPending({ db, linkId: link.id, userId: viewerId })
		}
		return failure('inviter_gone')
	}
	const org = await getOrgById(db, link.orgId)
	if (!org) return failure('invalid')
	const isMember = viewerId
		? Boolean(await getLiveOrgMembership(db, link.orgId, viewerId))
		: false
	const offer = await buildOffer({ db, link, orgSlug: org.slug, isMember })
	if (!offer) return failure('target_gone')
	const alreadyMember = viewerId
		? await inviteLinkAlreadySatisfied(db, link, viewerId)
		: false
	if (viewerId) {
		if (alreadyMember) {
			await clearInviteLinkPending({ db, linkId: link.id, userId: viewerId })
		} else if (
			link.target.kind !== 'membership' &&
			(await hasRedeemedInviteLink(db, link.id, viewerId))
		) {
			await clearInviteLinkPending({ db, linkId: link.id, userId: viewerId })
			return failure('already_used')
		} else {
			await recordInviteLinkPending({ db, linkId: link.id, userId: viewerId })
		}
	}
	return {
		ok: true,
		token,
		org: {
			slug: org.slug,
			displayName: org.display_name,
			avatarUrl: buildOrgAvatarUrl({
				slug: org.slug,
				avatarKey: org.avatar_key,
			}),
			personal: await isPersonalOrg(db, link.orgId),
		},
		offer,
		invitedBy: await readCreatorLabel(db, link.createdByUserId),
		expiresAt: link.expiresAt,
		alreadyMember,
		authenticated: Boolean(user),
	}
}

async function redirectAfterAccept(
	db: D1Database,
	orgId: string,
	target: InviteLinkTarget,
) {
	const org = await getOrgById(db, orgId)
	const slug = org?.slug
	if (!slug) return { orgSlug: null, redirectTo: '/' }
	switch (target.kind) {
		case 'membership':
			return { orgSlug: slug, redirectTo: `/@${slug}` }
		case 'team':
			return {
				orgSlug: slug,
				redirectTo: routes.orgTeams.href({ orgSlug: slug }),
			}
		case 'resource': {
			const pkg = await readPackageNames(db, orgId, target.resourceId)
			return {
				orgSlug: slug,
				redirectTo: pkg
					? routes.communityPackage.href({
							username: slug,
							kodyId: pkg.kody_id,
						})
					: `/@${slug}`,
			}
		}
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

/** Blocks the person cannot fix by trying again, so the pending row goes. */
const terminalBlocks = new Set<InviteLinkRedeemBlockReason>([
	'invalid',
	'revoked',
	'expired',
	'exhausted',
	'org_inactive',
	'personal_org',
	'inviter_gone',
	'target_gone',
	'already_used',
])

/** Shared by the `/join/:token` accept and the Organizations page accept. */
async function acceptInviteLink(input: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	link: StoredInviteLink
	rateKey: string
}) {
	const { env, user, link } = input
	const db = env.APP_DB
	const userId = user.mcpUser.userId
	const result = await redeemOrgInviteLink({
		db,
		env,
		link,
		user: {
			userId,
			email: user.email,
			emailVerified: user.emailVerified,
		},
		audit: orgAuditWriterFromRequest(env, user.request),
	})
	if (!result.ok) {
		if (result.reason === 'domain' || result.reason === 'unverified_email') {
			await releaseRateLimit(db, input.rateKey)
		}
		if (terminalBlocks.has(result.reason)) {
			await clearInviteLinkPending({ db, linkId: link.id, userId })
		}
		return operationResult(
			{ ok: false, error: result.error, reason: result.reason },
			400,
		)
	}
	await clearInviteLinkPending({ db, linkId: link.id, userId })
	const destination = await redirectAfterAccept(db, result.orgId, result.target)
	return operationResult({
		ok: true,
		alreadyMember: result.alreadyMember,
		kind: result.target.kind,
		role: result.role,
		...destination,
	})
}

async function rateLimited(request: Request, env: Env, key: string) {
	const rateKey = joinRateLimitKey(request, key)
	const limited = await checkRateLimit(
		env.APP_DB,
		rateKey,
		orgInviteJoinRateLimitConfig,
	)
	return { rateKey, allowed: limited.allowed }
}

function tooManyAttempts() {
	return operationResult(
		{ ok: false, error: 'Too many join attempts. Try again shortly.' },
		429,
	)
}

function invalidLinkResponse() {
	return operationResult(
		{
			ok: false,
			error: inviteLinkBlockMessage('invalid'),
			reason: 'invalid' satisfies InviteLinkRedeemBlockReason,
		},
		400,
	)
}

export async function joinWebsiteOrganization({
	env,
	request,
	user,
	token,
}: InviteOperationContext & { token: string }) {
	const limit = await rateLimited(request, env, token)
	if (!limit.allowed) return tooManyAttempts()
	const tokenHash = await hashInviteLinkToken(token.trim())
	const link = await getInviteLinkByTokenHash(env.APP_DB, tokenHash)
	if (!link) return invalidLinkResponse()
	return await acceptInviteLink({
		env,
		request,
		user,
		link,
		rateKey: limit.rateKey,
	})
}

export async function declineWebsiteOrganizationInvite({
	env,
	user,
	token,
}: InviteOperationContext & { token: string }) {
	const tokenHash = await hashInviteLinkToken(token.trim())
	const link = await getInviteLinkByTokenHash(env.APP_DB, tokenHash)
	if (!link) return invalidLinkResponse()
	await clearInviteLinkPending({
		db: env.APP_DB,
		linkId: link.id,
		userId: user.mcpUser.userId,
	})
	return operationResult({
		ok: true,
		redirectTo: `${routes.accountOrganizations.href()}#invites`,
	})
}

/**
 * Accept from the Organizations page. The pending row proves this person
 * opened the link, so the token is not needed again.
 */
export async function acceptWebsiteInviteLink({
	env,
	request,
	user,
	linkId,
}: InviteOperationContext & { linkId: string }) {
	const limit = await rateLimited(request, env, linkId)
	if (!limit.allowed) return tooManyAttempts()
	const link = linkId
		? await getPendingInviteLinkForPerson({
				db: env.APP_DB,
				linkId,
				userId: user.mcpUser.userId,
			})
		: null
	if (!link) return invalidLinkResponse()
	return await acceptInviteLink({
		env,
		request,
		user,
		link,
		rateKey: limit.rateKey,
	})
}

export async function declineWebsiteInviteLink({
	env,
	user,
	linkId,
}: InviteOperationContext & { linkId: string }) {
	const cleared = linkId
		? await clearInviteLinkPending({
				db: env.APP_DB,
				linkId,
				userId: user.mcpUser.userId,
			})
		: false
	if (!cleared) return invalidLinkResponse()
	return operationResult({ ok: true })
}

type InviteOperationContext = {
	env: Env
	request: Request
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
}
