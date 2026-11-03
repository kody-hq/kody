import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	compileAccessForActor,
	type CompiledAccess,
} from '#worker/authorization/access-compile.ts'
import { loadProfileChain, loadProfileGrants } from '#worker/profiles/store.ts'
import { profileStatus } from '#worker/profiles/rules.ts'
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import type { ExecutionContextRow } from './store.ts'

/**
 * The box login's access (ADR 0096) and the excess it holds over a grantee.
 * An entry is one permission, org-wide (`resource: null`) or on one resource
 * (`type:id`). An Owner login collapses to one `owner` entry.
 */
export type BoxAccessEntry = {
	permission: OrgPermission | 'owner'
	resource: string | null
}

export type BoxPrincipal = {
	kind: 'person' | 'profile'
	userId: string
	profileId: string | null
}

export type BoxAccess = {
	principal: BoxPrincipal
	entries: Array<BoxAccessEntry>
	/** True when the login profile or a parent is revoked or expired. */
	profileInactive: boolean
}

export const boxExcessDisplayCap = 50

export function boxPrincipal(row: ExecutionContextRow): BoxPrincipal {
	if (row.login_kind === 'profile' && row.login_profile_id) {
		return {
			kind: 'profile',
			userId: row.login_user_id ?? row.operator_user_id,
			profileId: row.login_profile_id,
		}
	}
	return {
		kind: 'person',
		userId: row.login_user_id ?? row.operator_user_id,
		profileId: null,
	}
}

function entryKey(entry: BoxAccessEntry) {
	return `${entry.permission}@${entry.resource ?? '*'}`
}

/** Every permission a compile holds, org-wide and per resource. */
export function compiledEntries(
	compiled: CompiledAccess,
): Array<BoxAccessEntry> {
	if (compiled.isOwner) return [{ permission: 'owner', resource: null }]
	const entries: Array<BoxAccessEntry> = []
	for (const permission of compiled.orgPermissions) {
		entries.push({ permission, resource: null })
	}
	for (const [resource, permissions] of compiled.resourcePermissions) {
		for (const permission of permissions) {
			if (!compiled.orgPermissions.has(permission)) {
				entries.push({ permission, resource })
			}
		}
	}
	return sortEntries(entries)
}

function sortEntries(entries: Array<BoxAccessEntry>) {
	return entries.sort((a, b) => entryKey(a).localeCompare(entryKey(b)))
}

type Layer = {
	orgPermissions: ReadonlySet<string>
	resourcePermissions: ReadonlyMap<string, ReadonlySet<string>>
}

function layerHolds(layer: Layer, entry: BoxAccessEntry) {
	if (entry.permission === 'owner') return false
	if (layer.orgPermissions.has(entry.permission)) return true
	if (!entry.resource) return false
	return (
		layer.resourcePermissions.get(entry.resource)?.has(entry.permission) ??
		false
	)
}

/** A person's live access narrowed by every profile layer (ADR 0092). */
export function narrowByProfile(
	base: CompiledAccess,
	layers: ReadonlyArray<Layer>,
): Array<BoxAccessEntry> {
	if (layers.length === 0) return compiledEntries(base)
	const [tip] = layers
	const candidates: Array<BoxAccessEntry> = []
	for (const permission of tip!.orgPermissions) {
		candidates.push({ permission: permission as OrgPermission, resource: null })
	}
	for (const [resource, permissions] of tip!.resourcePermissions) {
		for (const permission of permissions) {
			candidates.push({ permission: permission as OrgPermission, resource })
		}
	}
	return sortEntries(
		candidates.filter(
			(entry) =>
				holds(base, entry) && layers.every((layer) => layerHolds(layer, entry)),
		),
	)
}

/** Whether a compile holds an entry (an Owner holds everything). */
export function holds(compiled: CompiledAccess, entry: BoxAccessEntry) {
	if (compiled.isOwner) return true
	if (entry.permission === 'owner') return false
	if (compiled.orgPermissions.has(entry.permission)) return true
	if (!entry.resource) return false
	return (
		compiled.resourcePermissions.get(entry.resource)?.has(entry.permission) ??
		false
	)
}

/** What the box can do that the grantee cannot do personally. */
export function boxExcess(
	box: ReadonlyArray<BoxAccessEntry>,
	grantee: CompiledAccess,
): Array<BoxAccessEntry> {
	return box.filter((entry) => !holds(grantee, entry))
}

/** Changes when an entry is added or removed, or the box login changes. */
export async function excessFingerprint(
	principal: BoxPrincipal,
	entries: ReadonlyArray<BoxAccessEntry>,
) {
	const text = [
		`${principal.kind}:${principal.userId}:${principal.profileId ?? ''}`,
		...entries.map(entryKey),
	].join('\n')
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	)
	return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

/** True when `next` adds an entry `previous` lacked (removals never re-raise). */
export function addsEntries(
	previous: ReadonlyArray<BoxAccessEntry>,
	next: ReadonlyArray<BoxAccessEntry>,
) {
	const before = new Set(previous.map(entryKey))
	return next.some((entry) => !before.has(entryKey(entry)))
}

export async function liveRole(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<OrgRole | null> {
	const row = await db
		.prepare(
			`SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ role: OrgRole }>()
	return row?.role ?? null
}

export async function compileFor(
	db: D1Database,
	orgId: string,
	userId: string,
): Promise<CompiledAccess> {
	return await compileAccessForActor({
		db,
		orgId: orgId as OwnerId,
		userId,
		role: await liveRole(db, orgId, userId),
	})
}

/** The box login's live access in `orgId`. */
export async function loadBoxAccess(
	db: D1Database,
	row: ExecutionContextRow,
	orgId: string,
): Promise<BoxAccess> {
	const principal = boxPrincipal(row)
	const base = await compileFor(db, orgId, principal.userId)
	if (!principal.profileId) {
		return { principal, entries: compiledEntries(base), profileInactive: false }
	}
	const chain = await loadProfileChain(db, {
		orgId,
		profileId: principal.profileId,
	})
	const inactive =
		chain.at(-1)?.id !== principal.profileId ||
		chain.some((profile) => profile.acting_user_id !== principal.userId) ||
		profileStatus(chain, new Date().toISOString()) !== 'active'
	if (inactive) return { principal, entries: [], profileInactive: true }
	const grants = await loadProfileGrants(db, {
		orgId,
		profileIds: chain.map((profile) => profile.id),
	})
	const layers = [...chain].reverse().map((profile): Layer => {
		const orgPermissions = new Set<string>()
		const resourcePermissions = new Map<string, Set<string>>()
		for (const grant of grants.get(profile.id) ?? []) {
			if (grant.resourceType === 'org') {
				for (const permission of grant.permissions)
					orgPermissions.add(permission)
				continue
			}
			const key = `${grant.resourceType}:${grant.resourceId}`
			const set = resourcePermissions.get(key) ?? new Set<string>()
			for (const permission of grant.permissions) set.add(permission)
			resourcePermissions.set(key, set)
		}
		return { orgPermissions, resourcePermissions }
	})
	return {
		principal,
		entries: narrowByProfile(base, layers),
		profileInactive: false,
	}
}
