import { normalizeRepoWorkspacePath } from './manifest.ts'
import type { EntitySourceRow } from './types.ts'

/**
 * Re-keys a file set to the repo-relative shape published snapshots store.
 * Repo-session and clone snapshots are already keyed from the repo root;
 * publish check results are keyed from the source root, so their paths get
 * the source root prefix. Anything else is returned unchanged.
 */
export function repoRelativeSourceFiles(input: {
	source: Pick<EntitySourceRow, 'manifest_path' | 'source_root'>
	files: Record<string, string>
}) {
	if (typeof input.files[input.source.manifest_path] === 'string') {
		return input.files
	}
	const root = normalizeRepoWorkspacePath(input.source.source_root).replace(
		/\/+$/,
		'',
	)
	const prefix = `${root}/`
	const manifestPath = normalizeRepoWorkspacePath(input.source.manifest_path)
	if (!root || root === '.' || !manifestPath.startsWith(prefix)) {
		return input.files
	}
	if (typeof input.files[manifestPath.slice(prefix.length)] !== 'string') {
		return input.files
	}
	return Object.fromEntries(
		Object.entries(input.files).map(([path, content]) => [
			`${prefix}${normalizeRepoWorkspacePath(path)}`,
			content,
		]),
	)
}
