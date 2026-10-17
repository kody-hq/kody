import { relocateAccountHref } from '#universal/org-pages.ts'

export type ListDetailSelection = {
	selectedId: string | null
	isCreating: boolean
}

function appendSearch(pathname: string, search?: string) {
	return `${pathname}${search ?? ''}`
}

export function createListDetailLinks(basePath: string) {
	const newPath = `${basePath}/new`

	function publish(path: string, currentHref?: string) {
		if (!currentHref) return path
		return relocateAccountHref(path, currentHref)
	}

	function buildListHref(search = '', currentHref?: string) {
		return publish(appendSearch(basePath, search), currentHref)
	}

	function buildNewHref(search = '', currentHref?: string) {
		return publish(appendSearch(newPath, search), currentHref)
	}

	function buildDetailHref(id: string, search = '', currentHref?: string) {
		// Preserve the encoding used by existing resource links.
		return publish(
			appendSearch(
				`${basePath}/${encodeURIComponent(id).replaceAll('.', '%2E')}`,
				search,
			),
			currentHref,
		)
	}

	return {
		buildListHref,
		buildNewHref,
		buildDetailHref,
	}
}
