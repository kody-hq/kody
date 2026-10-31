import { McpCallerError } from '#mcp/caller-error.ts'
import { checkRateLimit, releaseRateLimit } from '#worker/app/rate-limit.ts'
import { getOrgBySlug } from '#worker/orgs/repo.ts'
import {
	getPackageNameLeaf,
	getPackageNameScope,
	isScopedPackageName,
} from '#worker/package-registry/package-name.ts'
import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import { getUserRepoByName } from '#worker/repo/user-repos.ts'
import {
	followAccessFromPermissions,
	loadFollowTargetPermissions,
} from './access.ts'
import {
	followEventCopy,
	followEventsForKind,
	normalizeFollowEvents,
} from '#universal/follows.ts'
import {
	deleteFollowForOrg,
	getFollowByTarget,
	insertFollow,
	listFollowsByFollower,
	resumeFollow,
	retargetFollowCreator,
	setFollowEvents,
} from './repo.ts'
import {
	followCreateMaxPerHour,
	followCreateWindowSeconds,
	followView,
	type FollowEvent,
	type FollowRecord,
	type FollowTargetKind,
	type FollowTargetSnapshot,
	type FollowView,
} from './types.ts'

const followCreateRateLimit = {
	maxRequests: followCreateMaxPerHour,
	windowSeconds: followCreateWindowSeconds,
}

function followCreateRateLimitKey(followerOrgId: string) {
	return `follow-create:${followerOrgId}`
}

/** A missing target and one the caller cannot read look the same. */
export class FollowTargetNotFoundError extends McpCallerError {
	constructor(name: string) {
		super(`Follow target ${JSON.stringify(name.trim())} was not found.`)
		this.name = 'FollowTargetNotFoundError'
	}
}

function followTargetNotFound(name: string) {
	return new FollowTargetNotFoundError(name)
}

export class FollowRateLimitError extends McpCallerError {
	constructor() {
		super(
			`Follow limit reached for this org (${followCreateMaxPerHour} new follows per hour). Try again in about an hour.`,
		)
		this.name = 'FollowRateLimitError'
	}
}

/** Counts one new follow. Deliveries and fork auto-follows do not call this. */
export async function consumeFollowCreateSlot(
	db: D1Database,
	followerOrgId: string,
) {
	const result = await checkRateLimit(
		db,
		followCreateRateLimitKey(followerOrgId),
		followCreateRateLimit,
	)
	if (!result.allowed) throw new FollowRateLimitError()
}

/**
 * Validates an explicit event choice for this target and caller. Omitted
 * events keep the stored choice (both events for a new follow).
 */
function resolveRequestedEvents(input: {
	target: FollowTargetSnapshot
	events: ReadonlyArray<FollowEvent> | undefined
	canPush: boolean
}): Array<FollowEvent> | null {
	if (input.events === undefined) return null
	const events = normalizeFollowEvents(input.events)
	if (events.length === 0) {
		throw new McpCallerError('Choose at least one event to follow.')
	}
	const available = followEventsForKind(input.target.kind)
	for (const event of events) {
		if (!available.includes(event)) {
			throw new McpCallerError(
				`Plain repos are never published, so ${input.target.name} can only be followed for pushes.`,
			)
		}
	}
	if (events.includes('pushed') && !input.canPush) {
		throw new McpCallerError(
			`${followEventCopy.pushed.label} from ${input.target.name} need read access to it. A Use grant includes read; run-only access does not.`,
		)
	}
	return events
}

function eventFlags(events: ReadonlyArray<FollowEvent>) {
	return {
		publishedEnabled: events.includes('published'),
		pushedEnabled: events.includes('pushed'),
	}
}

export async function addFollow(input: {
	env: Env
	followerOrgId: string
	creatorUserId: string
	creatorProfileId?: string | null
	name: string
	kind?: FollowTargetKind
	/** `published` and/or `pushed`. Omit to keep the current choice. */
	events?: ReadonlyArray<FollowEvent>
}): Promise<FollowView> {
	const requested = input.name.trim()
	if (!isScopedPackageName(requested)) {
		throw new McpCallerError(
			'Follow target must be an @handle/name, for example "@ada/notes".',
		)
	}
	const target = await resolveFollowTarget(input.env.APP_DB, {
		name: requested,
		kind: input.kind,
	})
	if (!target) throw followTargetNotFound(requested)
	const access = await loadFollowTargetPermissions({
		env: input.env,
		creatorUserId: input.creatorUserId,
		creatorProfileId: input.creatorProfileId ?? null,
		ownerId: target.ownerId,
	})
	const decision = followAccessFromPermissions({
		targetKind: target.kind,
		isPrivate: target.isPrivate,
		access,
		packageId: target.kind === 'package' ? target.id : null,
		ownerId: target.ownerId,
	})
	if (!decision.canCreate) throw followTargetNotFound(requested)
	const events = resolveRequestedEvents({
		target,
		events: input.events,
		canPush: decision.canPush,
	})

	const existing = await getFollowByTarget(input.env.APP_DB, {
		followerOrgId: input.followerOrgId,
		targetKind: target.kind,
		targetId: target.id,
	})
	const now = new Date().toISOString()
	if (existing) {
		return await settleExistingFollow({
			db: input.env.APP_DB,
			followerOrgId: input.followerOrgId,
			creatorUserId: input.creatorUserId,
			creatorProfileId: input.creatorProfileId ?? null,
			targetKind: target.kind,
			targetId: target.id,
			requested,
			existing,
			events,
			now,
		})
	}

	await consumeFollowCreateSlot(input.env.APP_DB, input.followerOrgId)
	const id = crypto.randomUUID()
	try {
		await insertFollow(input.env.APP_DB, {
			id,
			followerOrgId: input.followerOrgId,
			creatorUserId: input.creatorUserId,
			creatorProfileId: input.creatorProfileId ?? null,
			targetKind: target.kind,
			targetOwnerId: target.ownerId,
			targetId: target.id,
			targetName: target.name,
			createdAt: now,
			...(events ? eventFlags(events) : {}),
		})
	} catch (error) {
		const raced = await getFollowByTarget(input.env.APP_DB, {
			followerOrgId: input.followerOrgId,
			targetKind: target.kind,
			targetId: target.id,
		})
		if (raced) {
			await releaseRateLimit(
				input.env.APP_DB,
				followCreateRateLimitKey(input.followerOrgId),
			).catch(() => undefined)
			return await settleExistingFollow({
				db: input.env.APP_DB,
				followerOrgId: input.followerOrgId,
				creatorUserId: input.creatorUserId,
				creatorProfileId: input.creatorProfileId ?? null,
				targetKind: target.kind,
				targetId: target.id,
				requested,
				existing: raced,
				events,
				now,
			})
		}
		throw error
	}
	const created = await getFollowByTarget(input.env.APP_DB, {
		followerOrgId: input.followerOrgId,
		targetKind: target.kind,
		targetId: target.id,
	})
	if (!created) throw followTargetNotFound(requested)
	return followView(created)
}

export async function listFollowsForOrg(input: {
	db: D1Database
	followerOrgId: string
}): Promise<Array<FollowView>> {
	const rows = await listFollowsByFollower(input.db, input.followerOrgId)
	return rows.map(followView)
}

export class FollowNotFoundError extends McpCallerError {
	constructor(name: string) {
		super(`This org does not follow ${JSON.stringify(name.trim())}.`)
		this.name = 'FollowNotFoundError'
	}
}

/**
 * Unfollow by `@handle/name`. Matches the live target first, then the stored
 * name, so a follow whose target was deleted or became unreadable can still
 * be removed.
 */
export async function removeFollow(input: {
	env: Env
	followerOrgId: string
	name: string
	kind?: FollowTargetKind
}): Promise<{ removed: FollowView }> {
	const requested = input.name.trim()
	const follows = await listFollowsByFollower(
		input.env.APP_DB,
		input.followerOrgId,
	)
	const target = isScopedPackageName(requested)
		? await resolveFollowTarget(input.env.APP_DB, {
				name: requested,
				kind: input.kind,
			})
		: null
	const match =
		(target
			? follows.find(
					(follow) =>
						follow.targetKind === target.kind && follow.targetId === target.id,
				)
			: undefined) ??
		follows.find(
			(follow) =>
				follow.targetName.toLowerCase() === requested.toLowerCase() &&
				(input.kind === undefined || follow.targetKind === input.kind),
		)
	if (!match) throw new FollowNotFoundError(requested)
	await deleteFollowForOrg(input.env.APP_DB, {
		followerOrgId: input.followerOrgId,
		id: match.id,
	})
	return { removed: followView(match) }
}

/**
 * Resume/retarget an existing follow for the authorized caller. Compare-and-
 * swap misses reload and retry a few times so a concurrent pause/resume does
 * not return a synthetic active view with the wrong creator.
 */
async function settleExistingFollow(input: {
	db: D1Database
	followerOrgId: string
	creatorUserId: string
	creatorProfileId?: string | null
	targetKind: FollowTargetKind
	targetId: string
	requested: string
	existing: FollowRecord
	events: Array<FollowEvent> | null
	now: string
}): Promise<FollowView> {
	const settled = await settleExistingFollowStatus(input)
	if (!input.events) return settled
	const flags = eventFlags(input.events)
	await setFollowEvents(input.db, {
		id: input.existing.id,
		...flags,
		updatedAt: input.now,
	})
	const updated = await getFollowByTarget(input.db, {
		followerOrgId: input.followerOrgId,
		targetKind: input.targetKind,
		targetId: input.targetId,
	})
	if (!updated) throw followTargetNotFound(input.requested)
	return followView(updated)
}

async function settleExistingFollowStatus(input: {
	db: D1Database
	followerOrgId: string
	creatorUserId: string
	creatorProfileId?: string | null
	targetKind: FollowTargetKind
	targetId: string
	requested: string
	existing: FollowRecord
	now: string
}): Promise<FollowView> {
	let row = input.existing
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (row.status === 'paused') {
			const resumed = await resumeFollow(input.db, {
				id: row.id,
				updatedAt: input.now,
				creatorUserId: input.creatorUserId,
				creatorProfileId: input.creatorProfileId ?? null,
			})
			if (resumed) {
				return followView({
					...row,
					status: 'active',
					pausedAt: null,
					pausedReason: null,
					creatorUserId: input.creatorUserId,
					creatorProfileId: input.creatorProfileId ?? null,
					updatedAt: input.now,
				})
			}
		} else if (
			row.creatorUserId !== input.creatorUserId ||
			row.creatorProfileId !== (input.creatorProfileId ?? null)
		) {
			// Member deletion anonymizes creator_user_id to deleted-user while
			// the org follow stays active. Retarget so a teammate who re-adds
			// can gate delivery before the next publish pauses a private target.
			const retargeted = await retargetFollowCreator(input.db, {
				id: row.id,
				updatedAt: input.now,
				creatorUserId: input.creatorUserId,
				creatorProfileId: input.creatorProfileId ?? null,
			})
			if (retargeted) {
				return followView({
					...row,
					creatorUserId: input.creatorUserId,
					creatorProfileId: input.creatorProfileId ?? null,
					updatedAt: input.now,
				})
			}
		} else {
			return followView(row)
		}
		const current = await getFollowByTarget(input.db, {
			followerOrgId: input.followerOrgId,
			targetKind: input.targetKind,
			targetId: input.targetId,
		})
		if (!current) throw followTargetNotFound(input.requested)
		row = current
	}
	return followView(row)
}

/**
 * `@handle/name` → package or plain repo. When `kind` is omitted and both
 * exist, the package wins. A missing org, package, and repo all return null
 * so the caller can use one not-found error.
 */
export async function resolveFollowTarget(
	db: D1Database,
	input: { name: string; kind?: FollowTargetKind },
): Promise<FollowTargetSnapshot | null> {
	const handle = getPackageNameScope(input.name)
	const leaf = getPackageNameLeaf(input.name).toLowerCase()
	if (!handle || !leaf) return null
	const org = await getOrgBySlug(db, handle)
	if (!org) return null
	const scopedName = `@${org.slug}/${leaf}`
	switch (input.kind) {
		case 'repo':
			return resolveRepo(db, org.id, leaf, scopedName)
		case 'package':
			return resolvePackage(db, org.id, scopedName)
		case undefined:
			return (
				(await resolvePackage(db, org.id, scopedName)) ??
				(await resolveRepo(db, org.id, leaf, scopedName))
			)
		default: {
			const exhaustive: never = input.kind
			throw new Error(`Unsupported follow target kind: ${exhaustive}`)
		}
	}
}

async function resolvePackage(
	db: D1Database,
	ownerId: string,
	scopedName: string,
): Promise<FollowTargetSnapshot | null> {
	const saved = await getSavedPackageByName(db, {
		userId: ownerId,
		name: scopedName,
	})
	if (!saved) return null
	return {
		kind: 'package',
		ownerId: saved.userId,
		id: saved.id,
		name: saved.name,
		isPrivate: saved.isPrivate,
	}
}

async function resolveRepo(
	db: D1Database,
	ownerId: string,
	leaf: string,
	scopedName: string,
): Promise<FollowTargetSnapshot | null> {
	const repo = await getUserRepoByName(db, { userId: ownerId, name: leaf })
	if (!repo) return null
	return {
		kind: 'repo',
		ownerId: repo.userId,
		id: repo.id,
		name: scopedName,
		isPrivate: repo.isPrivate,
	}
}
