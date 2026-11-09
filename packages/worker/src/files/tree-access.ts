import { type FileMetadata } from '#universal/files.ts'
import {
	checkPermission,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
/** Restrictions intersect down the tree. Explicit child shares cannot reopen a restricted ancestor. */
export function fileTreePermission(
	access: EffectivePermissions,
	files: ReadonlyMap<string, FileMetadata>,
	permission: OrgPermission,
	id: string,
) {
	const chain: FileMetadata[] = [],
		seen = new Set<string>()
	let cursor: string | undefined = id
	while (cursor) {
		if (seen.has(cursor)) return false
		seen.add(cursor)
		const file = files.get(cursor)
		if (!file) return false
		chain.push(file)
		cursor = file.parentId
	}
	const resource = (file: FileMetadata) => ({
		type: 'file' as const,
		id: file.id,
		orgId: access.orgId,
	})
	for (const file of chain)
		if (file.accessMode === 'restricted' && !access.isOwner) {
			const direct = access.resourcePermissions.get(`file:${file.id}`)
			if (
				!direct?.has('file:read') ||
				!direct.has(permission) ||
				!checkPermission(access, permission, resource(file)).allowed
			)
				return false
		}
	return chain.some(
		(file) => checkPermission(access, permission, resource(file)).allowed,
	)
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
