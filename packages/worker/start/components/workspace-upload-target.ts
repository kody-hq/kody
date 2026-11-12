import type { FileMetadata } from '#universal/files.ts'
import { isWorkspaceContainer } from '#universal/workspace-page.ts'

/** The nearest row or column wins, including an explicit workspace root. */
export function workspaceUploadTarget(
	target: Element,
	files: Array<FileMetadata & { access: { write: boolean } }>,
	fallbackId?: string,
) {
	const zone = target.closest<HTMLElement>(
		'[data-workspace-item], [data-upload-directory], [data-system-directory], [data-package-item]',
	)
	if (zone?.matches('[data-system-directory], [data-package-item]')) return null
	let id = fallbackId
	if (zone?.hasAttribute('data-upload-directory')) {
		id = zone.dataset.uploadDirectory || undefined
	} else if (zone?.dataset.workspaceItem) {
		const item = files.find((file) => file.id === zone.dataset.workspaceItem)
		if (!item) return null
		id = isWorkspaceContainer(item.mediaType) ? item.id : item.parentId
	}
	const container = id ? files.find((file) => file.id === id) : undefined
	if (id && (!container || !isWorkspaceContainer(container.mediaType)))
		return null
	return {
		id,
		name: container?.name ?? 'Workspace',
		writable: !container || container.access.write,
		zone,
	}
}
