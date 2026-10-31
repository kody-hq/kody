import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	checkOrgWide,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { getOrgById, loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { getUserRepoByIdInAnyOrg } from '#worker/repo/user-repos.ts'
import {
	type FollowRecord,
	type FollowTargetKind,
	type FollowTargetSnapshot,
} from './types.ts'

export type FollowPermissionDecision = {
	canCreate: boolean
	canPush: boolean
}

/**
 * Create and push decisions for one target.
 *
 * Public targets are followable by any signed-in caller (`canCreate`).
 * Private packages require `package:read` on that package (a `use` grant
 * qualifies; `package:execute` alone does not). Private repos require
 * org-wide `package:read` in the owner org — a grant on one package does
 * not name a repo. Push delivery always requires that same read: package
 * `package:read` for packages, org-wide `package:read` for plain repos.
 * Preset names are never consulted; only the expanded permissions are.
 */
export function followAccessFromPermissions(input: {
	targetKind: FollowTargetKind
	isPrivate: boolean
	access: EffectivePermissions | null
	packageId: string | null
	ownerId: string
}): FollowPermissionDecision {
	const canReadPackage =
		input.targetKind === 'package' &&
		input.packageId !== null &&
		packageReadAllowed(input.access, input.packageId, input.ownerId)
	const orgWideRead = orgWidePackageReadAllowed(input.access)
	let canPush = false
	switch (input.targetKind) {
		case 'package':
			canPush = canReadPackage
			break
		case 'repo':
			canPush = orgWideRead
			break
		default: {
			const exhaustive: never = input.targetKind
			throw new Error(`Unsupported follow target kind: ${exhaustive}`)
		}
	}
	if (!input.isPrivate) return { canCreate: true, canPush }
	let canCreate = false
	switch (input.targetKind) {
		case 'package':
			canCreate = canReadPackage
			break
		case 'repo':
			canCreate = orgWideRead
			break
		default: {
			const exhaustive: never = input.targetKind
			throw new Error(`Unsupported follow target kind: ${exhaustive}`)
		}
	}
	return { canCreate, canPush }
}

function packageReadAllowed(
	access: EffectivePermissions | null,
	packageId: string,
	ownerId: string,
) {
	if (!access) return false
	return checkPermission(
		access,
		'package:read',
		packageResource({ id: packageId, userId: ownerId }),
	).allowed
}

function orgWidePackageReadAllowed(access: EffectivePermissions | null) {
	if (!access) return false
	return checkOrgWide(access, 'package:read').allowed
}

/**
 * Live package or repo for a follow. Lookup is by target id across orgs,
 * not the denormalized owner, so an org transfer does not make the target
 * look missing. Access checks use the live owner and live name.
 */
export async function loadFollowTargetSnapshot(
	db: D1Database,
	follow: Pick<
		FollowRecord,
		'targetKind' | 'targetOwnerId' | 'targetId' | 'targetName'
	>,
): Promise<FollowTargetSnapshot | null> {
	switch (follow.targetKind) {
		case 'package': {
			const saved = await getSavedPackageByIdInAnyOrg(db, follow.targetId)
			if (!saved) return null
			return {
				kind: 'package',
				ownerId: saved.userId,
				id: saved.id,
				name: saved.name || follow.targetName,
				isPrivate: saved.isPrivate,
			}
		}
		case 'repo': {
			const repo = await getUserRepoByIdInAnyOrg(db, follow.targetId)
			if (!repo) return null
			const org = await getOrgById(db, repo.userId)
			return {
				kind: 'repo',
				ownerId: repo.userId,
				id: repo.id,
				name: org ? `@${org.slug}/${repo.name}` : follow.targetName,
				isPrivate: repo.isPrivate,
			}
		}
		default: {
			const exhaustive: never = follow.targetKind
			throw new Error(`Unsupported follow target kind: ${exhaustive}`)
		}
	}
}

/**
 * Permissions of `creatorUserId` inside the target owner's org. No binding
 * means no grant and no membership. Delivery uses this rather than the
 * token that created the follow.
 */
export async function loadFollowTargetPermissions(input: {
	env: Env
	creatorUserId: string
	/** Profile (ADR 0092) that created the follow; null is the person. */
	creatorProfileId?: string | null
	ownerId: string
}): Promise<EffectivePermissions | null> {
	const binding = await loadOrgBindingForOrg(
		input.env.APP_DB,
		input.creatorUserId,
		input.ownerId,
	)
	if (!binding) return null
	return await computeEffectivePermissions({
		env: input.env,
		request: deriveRequestContext({
			user: {
				userId: personIdFromStored(input.creatorUserId),
				username: '',
			},
			source: { kind: 'session' },
			orgBinding: binding,
			profileId: input.creatorProfileId ?? null,
		}),
	})
}

export async function resolveFollowDeliveryAccess(input: {
	env: Env
	creatorUserId: string
	creatorProfileId?: string | null
	target: FollowTargetSnapshot
}): Promise<FollowPermissionDecision> {
	const access = await loadFollowTargetPermissions({
		env: input.env,
		creatorUserId: input.creatorUserId,
		creatorProfileId: input.creatorProfileId ?? null,
		ownerId: input.target.ownerId,
	}).catch((error: unknown) => {
		console.error('follow-access-lookup-failed', error)
		return null
	})
	return followAccessFromPermissions({
		targetKind: input.target.kind,
		isPrivate: input.target.isPrivate,
		access,
		packageId: input.target.kind === 'package' ? input.target.id : null,
		ownerId: input.target.ownerId,
	})
}
