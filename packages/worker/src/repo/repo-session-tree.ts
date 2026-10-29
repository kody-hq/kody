import { buildRepoDisallowedPathMessage } from './repo-session-caller-error.ts'
import {
	type EntitySourceRow,
	type RepoSessionInfoResult,
	type RepoSessionRow,
	type RepoSessionTreeResult,
} from './types.ts'

function normalizeUnknownTreeChild(
	child: unknown,
	parentPath: string,
): {
	path: string
	name: string
	type: 'file' | 'directory' | 'symlink'
	size: number
	children?: Array<unknown>
} {
	const input =
		child && typeof child === 'object'
			? (child as Record<string, unknown>)
			: ({} as Record<string, unknown>)
	return {
		path: typeof input.path === 'string' ? input.path : `${parentPath}/unknown`,
		name: typeof input.name === 'string' ? input.name : 'unknown',
		type:
			input.type === 'file' ||
			input.type === 'directory' ||
			input.type === 'symlink'
				? input.type
				: 'file',
		size: typeof input.size === 'number' ? input.size : 0,
		children: Array.isArray(input.children)
			? (input.children as Array<unknown>)
			: undefined,
	}
}

type ResolvedWorkspaceSegments =
	| { ok: true; segments: Array<string> }
	| { ok: false; reason: 'escape' | 'git' }

function resolveWorkspaceRelativeSegments(
	path: string,
	workspacePrefix: string,
): ResolvedWorkspaceSegments {
	const relative =
		path === workspacePrefix
			? ''
			: path.startsWith(`${workspacePrefix}/`)
				? path.slice(workspacePrefix.length + 1)
				: null
	if (relative === null) {
		return { ok: false, reason: 'escape' }
	}
	const resolved: Array<string> = []
	for (const segment of relative.split('/')) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') {
			if (resolved.length === 0) return { ok: false, reason: 'escape' }
			resolved.pop()
			continue
		}
		if (segment === '.git') return { ok: false, reason: 'git' }
		resolved.push(segment)
	}
	return { ok: true, segments: resolved }
}

export function resolveRepoWorkspacePath(
	path: string,
	workspacePrefix: string,
) {
	const trimmed = path.trim()
	if (!trimmed) {
		throw new Error('A non-empty repo path is required.')
	}
	// User-supplied paths must stay inside the session workspace and out of
	// git internals. Resolve `.` / `..` first so in-workspace forms such as
	// `src/../exports/self-test.ts` work, then reject anything that leaves the
	// prefix or names a `.git` segment.
	const joined =
		trimmed === workspacePrefix || trimmed.startsWith(`${workspacePrefix}/`)
			? trimmed
			: `${workspacePrefix}/${trimmed.replace(/^\/+/, '')}`
	const resolved = resolveWorkspaceRelativeSegments(joined, workspacePrefix)
	if (!resolved.ok) {
		throw new Error(buildRepoDisallowedPathMessage(trimmed, resolved.reason))
	}
	return resolved.segments.length === 0
		? workspacePrefix
		: `${workspacePrefix}/${resolved.segments.join('/')}`
}

/** Canonical repo-relative spelling (`./a//b` and `x/../a/b` become `a/b`). */
export function canonicalRepoPath(path: string) {
	const prefix = '/session'
	return toExternalRepoPath(resolveRepoWorkspacePath(path, prefix), prefix)
}

export function toExternalRepoPath(path: string, workspacePrefix: string) {
	return path.startsWith(`${workspacePrefix}/`)
		? path.slice(workspacePrefix.length + 1)
		: path
}

export function toRepoSessionTreeResult(input: {
	node: {
		path: string
		name: string
		type: 'file' | 'directory' | 'symlink'
		size: number
		children?: Array<unknown>
	}
	workspacePrefix: string
}): RepoSessionTreeResult {
	return {
		path: toExternalRepoPath(input.node.path, input.workspacePrefix),
		name: input.node.name,
		type: input.node.type,
		size: input.node.size,
		children: input.node.children?.map((child): RepoSessionTreeResult =>
			toRepoSessionTreeResult({
				node: normalizeUnknownTreeChild(child, input.node.path),
				workspacePrefix: input.workspacePrefix,
			}),
		),
	}
}

export function toRepoSessionInfoResult(
	session: RepoSessionRow,
	source: EntitySourceRow,
): RepoSessionInfoResult {
	return {
		id: session.id,
		source_id: session.source_id,
		source_root: session.source_root,
		base_commit: session.base_commit,
		session_branch: session.session_branch,
		source_branch: session.source_branch,
		conversation_id: session.conversation_id,
		last_checkpoint_commit: session.last_checkpoint_commit,
		last_check_run_id: session.last_check_run_id,
		last_check_tree_hash: session.last_check_tree_hash,
		expires_at: session.expires_at,
		created_at: session.created_at,
		updated_at: session.updated_at,
		published_commit: source.published_commit,
		manifest_path: source.manifest_path,
		entity_type: source.entity_kind,
	}
}
