import type { FileMetadata } from '#universal/files.ts'
import {
	type AuthorizationError,
	checkPermission,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
export type FileTreeDecision =
	| { allowed: true }
	| { allowed: false; missing: 'file' | 'parent' }
	| { allowed: false; error: AuthorizationError }

/**
 * Restrictions intersect down the tree. Explicit child shares cannot reopen a
 * restricted ancestor. A file or ancestor absent from `files` is reported as
 * missing, not as a denial; a denial carries the authorizer's error.
 */
export function fileTreeAccess(
	access: EffectivePermissions,
	files: ReadonlyMap<string, FileMetadata>,
	permission: OrgPermission,
	id: string,
): FileTreeDecision {
	const chain: FileMetadata[] = [],
		seen = new Set<string>()
	let cursor: string | undefined = id
	while (cursor) {
		if (seen.has(cursor)) return { allowed: false, missing: 'parent' }
		seen.add(cursor)
		const file = files.get(cursor)
		if (!file)
			return { allowed: false, missing: cursor === id ? 'file' : 'parent' }
		chain.push(file)
		cursor = file.parentId
	}
	const resource = (file: FileMetadata) => ({
		type: 'file' as const,
		id: file.id,
		orgId: access.orgId,
	})
	// Org-wide grants never reach through a restricted ancestor: only its direct grants count.
	const directOnly = { ...access, permissions: new Set<OrgPermission>() }
	for (const file of chain)
		if (file.accessMode === 'restricted' && !access.isOwner) {
			if (
				permission !== 'file:read' &&
				!access.resourcePermissions.get(`file:${file.id}`)?.has('file:read')
			) {
				const read = checkPermission(directOnly, 'file:read', resource(file))
				if (!read.allowed) return read
			}
			const decision = checkPermission(directOnly, permission, resource(file))
			if (!decision.allowed) return decision
		}
	const denials: AuthorizationError[] = []
	for (const file of chain) {
		const decision = checkPermission(access, permission, resource(file))
		if (decision.allowed) return decision
		denials.push(decision.error)
	}
	// A grant held on an ancestor but blocked later (token scope, profile) explains more than the target's missing grant.
	const error =
		denials.find((denial) => denial.code !== 'missing_permission') ?? denials[0]
	return error ? { allowed: false, error } : { allowed: false, missing: 'file' }
}

export function fileTreePermission(
	access: EffectivePermissions,
	files: ReadonlyMap<string, FileMetadata>,
	permission: OrgPermission,
	id: string,
) {
	return fileTreeAccess(access, files, permission, id).allowed
}

/** Load only the active ancestry, never the entire org for a cursor update. */
export async function loadFileAncestors(
	read: (id: string) => Promise<FileMetadata | null>,
	id: string,
) {
	const files = new Map<string, FileMetadata>()
	let cursor: string | undefined = id
	while (cursor && !files.has(cursor)) {
		const file = await read(cursor)
		if (!file) break
		files.set(file.id, file)
		cursor = file.parentId
	}
	return files
}

/** A child link never publishes through a private ancestor. The link root is an explicit publication. */
export function filePublicParentAllows(
	files: ReadonlyMap<string, FileMetadata>,
	rootId: string,
) {
	const seen = new Set([rootId])
	let id = files.get(rootId)?.parentId
	while (id) {
		if (seen.has(id)) return false
		seen.add(id)
		const parent = files.get(id)
		if (!parent || parent.trashedAt || parent.accessMode === 'restricted')
			return false
		id = parent.parentId
	}
	return files.has(rootId)
}
