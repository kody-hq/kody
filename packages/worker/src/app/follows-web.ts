import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	followAccessFromPermissions,
	loadFollowTargetPermissions,
	loadFollowTargetSnapshot,
} from '#worker/follow/access.ts'
import {
	deleteFollowForOrg,
	getFollowByTarget,
	getFollowForOrg,
	listFollowsByFollower,
} from '#worker/follow/repo.ts'
import {
	addFollow,
	FollowNotFoundError,
	FollowRateLimitError,
	FollowTargetNotFoundError,
	removeFollow,
	resolveFollowTarget,
} from '#worker/follow/service.ts'
import {
	followRecordEvents,
	type FollowRecord,
	type FollowView,
} from '#worker/follow/types.ts'
import { listOrgsForPerson } from '#worker/orgs/repo.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { getCommunityPackageHrefFromName } from '#universal/community-links.ts'
import {
	followEventsForKind,
	followPausedDeleteAt,
	type FollowSummary,
	type FollowTargetKindName,
	type OrgFollowRow,
	type OrgFollowsLoaderData,
	type FollowEvent,
	type FollowOperationResult,
	type PackageFollowStatePayload,
} from '#universal/follows.ts'

function summaryFromRecord(record: FollowRecord): FollowSummary {
	return {
		status: record.status,
		events: followRecordEvents(record),
		pausedAt: record.pausedAt,
		pausedReason: record.pausedReason,
		lastDeliverySkipReason: record.lastDeliverySkipReason,
	}
}

function summaryFromView(view: FollowView): FollowSummary {
	return {
		status: view.status,
		events: view.events,
		pausedAt: view.paused_at,
		pausedReason: view.paused_reason,
		lastDeliverySkipReason: view.last_delivery_skip_reason,
	}
}

/**
 * Follow control data for one package or plain repo page. Null when the
 * viewer cannot follow it, which the caller reports the same as missing.
 */
export async function loadPackageFollowState(input: {
	env: Env
	user: AuthenticatedAppUser
	username: string
	kodyId: string
	kind: FollowTargetKindName | undefined
}): Promise<PackageFollowStatePayload | null> {
	const target = await resolveFollowTarget(input.env.APP_DB, {
		name: `@${input.username}/${input.kodyId}`,
		kind: input.kind,
	})
	if (!target) return null
	const personId = input.user.mcpUser.userId
	const access = await loadFollowTargetPermissions({
		env: input.env,
		creatorUserId: personId,
		ownerId: target.ownerId,
	})
	const decision = followAccessFromPermissions({
		targetKind: target.kind,
		isPrivate: target.isPrivate,
		access,
		packageId: target.kind === 'package' ? target.id : null,
		ownerId: target.ownerId,
	})
	if (!decision.canCreate) return null
	const personalOrgId = personalOrgIdForPerson(input.user.mcpUser)
	const orgs = (await listOrgsForPerson(input.env.APP_DB, personId)).filter(
		(org) => org.role !== null,
	)
	const workspaces = await Promise.all(
		orgs.map(async (org) => {
			const follow = await getFollowByTarget(input.env.APP_DB, {
				followerOrgId: org.id,
				targetKind: target.kind,
				targetId: target.id,
			})
			return {
				slug: org.slug,
				displayName: org.display_name,
				personal: org.id === personalOrgId,
				follow: follow ? summaryFromRecord(follow) : null,
			}
		}),
	)
	workspaces.sort((left, right) =>
		left.personal === right.personal
			? left.slug.localeCompare(right.slug)
			: left.personal
				? -1
				: 1,
	)
	return {
		ok: true,
		target: { name: target.name, kind: target.kind },
		availableEvents: followEventsForKind(target.kind),
		canPush: decision.canPush,
		workspaces,
	}
}

function orgFollowRow(record: FollowRecord): OrgFollowRow {
	return {
		...summaryFromRecord(record),
		id: record.id,
		name: record.targetName,
		kind: record.targetKind,
		href: getCommunityPackageHrefFromName(record.targetName),
		availableEvents: followEventsForKind(record.targetKind),
		createdAt: record.createdAt,
		deleteAt:
			record.status === 'paused' ? followPausedDeleteAt(record.pausedAt) : null,
		lastDeliverySkipAt: record.lastDeliverySkipAt,
	}
}

export async function loadOrgFollowsData(input: {
	env: Env
	org: { id: string; slug: string }
}): Promise<OrgFollowsLoaderData> {
	const follows = await listFollowsByFollower(input.env.APP_DB, input.org.id)
	return {
		ok: true,
		orgSlug: input.org.slug,
		follows: follows.map(orgFollowRow),
	}
}

function followError(
	code: Extract<FollowOperationResult, { ok: false }>['code'],
	error: string,
) {
	return { ok: false as const, code, error }
}

export function followOperationStatus(payload: FollowOperationResult) {
	if (payload.ok) return 200
	switch (payload.code) {
		case 'invalid':
			return 400
		case 'unauthorized':
			return 401
		case 'not_found':
			return 404
		case 'rate_limited':
			return 429
		default: {
			const exhaustive: never = payload.code
			throw new Error(`Unhandled follow error code: ${String(exhaustive)}`)
		}
	}
}

type FollowContext = {
	env: Env
	user: AuthenticatedAppUser
	org: { id: string }
}
type FollowTarget = { name: string; kind: FollowTargetKindName }

async function followOperation(
	run: () => Promise<FollowOperationResult>,
): Promise<FollowOperationResult> {
	try {
		return await run()
	} catch (error) {
		if (error instanceof FollowRateLimitError) {
			return followError('rate_limited', error.message)
		}
		if (
			error instanceof FollowNotFoundError ||
			error instanceof FollowTargetNotFoundError
		) {
			return followError('not_found', error.message)
		}
		if (error instanceof McpCallerError) {
			return followError('invalid', error.message)
		}
		throw error
	}
}

export function followOrgTarget(
	input: FollowContext & FollowTarget & { events?: Array<FollowEvent> },
) {
	return followOperation(async () => {
		const follow = await addFollow({
			env: input.env,
			followerOrgId: input.org.id,
			creatorUserId: input.user.mcpUser.userId,
			name: input.name,
			kind: input.kind,
			events: input.events,
		})
		return {
			ok: true,
			name: follow.name,
			kind: follow.kind,
			follow: summaryFromView(follow),
		}
	})
}

export function resumeOrgFollow(input: FollowContext & { id: string }) {
	return followOperation(async () => {
		const record = await getFollowForOrg(input.env.APP_DB, {
			followerOrgId: input.org.id,
			id: input.id,
		})
		if (!record) return followError('not_found', 'This follow is already gone.')
		const live = await loadFollowTargetSnapshot(input.env.APP_DB, record)
		if (!live)
			return followError(
				'not_found',
				`${record.targetName} no longer exists, so this follow can’t resume. Unfollow to remove it.`,
			)
		return followOrgTarget({ ...input, ...live })
	})
}

export function unfollowOrgTarget(
	input: FollowContext & (FollowTarget | { id: string }),
) {
	return followOperation(async () => {
		if ('id' in input) {
			const record = await getFollowForOrg(input.env.APP_DB, {
				followerOrgId: input.org.id,
				id: input.id,
			})
			if (
				!record ||
				!(await deleteFollowForOrg(input.env.APP_DB, {
					followerOrgId: input.org.id,
					id: input.id,
				}))
			)
				return followError('not_found', 'This follow is already gone.')
			return {
				ok: true,
				name: record.targetName,
				kind: record.targetKind,
				follow: null,
			}
		}
		const { removed } = await removeFollow({
			env: input.env,
			followerOrgId: input.org.id,
			name: input.name,
			kind: input.kind,
		})
		return { ok: true, name: removed.name, kind: removed.kind, follow: null }
	})
}
