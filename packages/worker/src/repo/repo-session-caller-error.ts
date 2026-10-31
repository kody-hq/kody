/**
 * Stable phrase from RepoSession DO `requireSession` when a session is no
 * longer `active` (typically `published`). Subclass identity does not survive
 * Durable Object RPC, so MCP observability matches this phrase to keep those
 * expected workflow misses on `mcp-event` and out of Sentry.
 */
export const repoSessionInactiveMessagePhrase =
	'; open a new session before continuing.'

export function isRepoSessionInactiveMessage(message: string) {
	return (
		message.startsWith('Repo session "') &&
		message.includes(repoSessionInactiveMessagePhrase)
	)
}

/**
 * Stable phrases from RepoSession DO `getSessionState` when the catalog has no
 * row for the given id (or the row belongs to another user). Agents often pass
 * placeholders (`none`, `null`) or stale ids; treat those as caller-correctable
 * so they stay on `mcp-event` and out of Sentry. KODY-CLOUDFLARE-5V.
 *
 * Match allows an optional trailing guidance sentence after the period.
 */
export function isRepoSessionNotFoundMessage(message: string) {
	return (
		message.startsWith('Repo session "') &&
		/" was not found(\.| for this user\.)/.test(message)
	)
}

export const repoSessionNotFoundGuidance =
	'Use repoListSessions or repoOpenSession to obtain a valid session_id.'

export function buildRepoSessionNotFoundMessage(sessionId: string) {
	return `Repo session "${sessionId}" was not found. ${repoSessionNotFoundGuidance}`
}

export function buildRepoSessionNotFoundForUserMessage(sessionId: string) {
	return `Repo session "${sessionId}" was not found for this user. ${repoSessionNotFoundGuidance}`
}

/**
 * isomorphic-git `PushRejectedError` for non-fast-forward pushes. Publish maps
 * these to `base_moved` so agents rebase; when a plain Error still escapes DO
 * RPC (subclass identity lost), MCP observability matches this phrase.
 * KODY-CLOUDFLARE-5M.
 */
export const gitPushNotFastForwardMessagePhrase = 'not a simple fast-forward'

export function isGitPushNotFastForwardMessage(message: string) {
	return message.includes(gitPushNotFastForwardMessagePhrase)
}

export function isGitPushNotFastForwardError(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	const name =
		'name' in error && typeof error.name === 'string' ? error.name : null
	const code =
		'code' in error && typeof error.code === 'string' ? error.code : null
	if (name === 'PushRejectedError' || code === 'PushRejectedError') {
		const message =
			'message' in error && typeof error.message === 'string'
				? error.message
				: ''
		// tag-exists uses the same error class; only treat non-FF as recoverable.
		return message.length === 0 || isGitPushNotFastForwardMessage(message)
	}
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isGitPushNotFastForwardMessage(error.message)
}

/**
 * Stable prefix for invalid `mode=regex` patterns from repo session search.
 * Agents often pass Python/PCRE inline flags (`(?s)`, `(?i)`) that JavaScript
 * RegExp rejects; treat those as caller-correctable input, not platform bugs.
 */
export const repoSearchInvalidRegexMessagePrefix =
	'repoSearch received an invalid regex'

export function isRepoSearchInvalidRegexMessage(message: string) {
	return message.startsWith(repoSearchInvalidRegexMessagePrefix)
}

/**
 * Stable prefix when `repoSearch` gets a blank or whitespace-only pattern.
 * Schema trims and rejects these at the MCP/Open API boundary; the DO still
 * throws this phrase for other entry points. Subclass identity does not
 * survive Durable Object RPC. KODY-BA.
 */
export const repoSearchEmptyPatternMessagePrefix =
	'repoSearch requires a non-empty pattern'

export function isRepoSearchEmptyPatternMessage(message: string) {
	return message.startsWith(repoSearchEmptyPatternMessagePrefix)
}

export function buildRepoSearchEmptyPatternCallerMessage() {
	return (
		`${repoSearchEmptyPatternMessagePrefix}. ` +
		'Pass literal text or a JavaScript RegExp pattern; whitespace-only patterns are rejected.'
	)
}

/**
 * Stable phrase from `resolveRepoWorkspacePath` when a caller path escapes
 * the session workspace or names a `.git` segment. Subclass identity does
 * not survive Durable Object RPC. Also match the pre-normalization wording
 * so in-flight events from the old "reject any `..`" guard stay off Sentry.
 */
export const repoDisallowedPathMessagePhrase =
	'is not allowed for repo session paths'

export const repoLegacyDisallowedPathMessagePhrase =
	'paths cannot contain ".." or ".git" segments'

export function isRepoDisallowedPathMessage(message: string) {
	return (
		message.includes(repoDisallowedPathMessagePhrase) ||
		message.includes(repoLegacyDisallowedPathMessagePhrase)
	)
}

export function buildRepoDisallowedPathMessage(
	path: string,
	reason: 'escape' | 'git',
) {
	switch (reason) {
		case 'escape':
			return `Repo path "${path}" ${repoDisallowedPathMessagePhrase}: resolved path leaves the session workspace.`
		case 'git':
			return `Repo path "${path}" ${repoDisallowedPathMessagePhrase}: paths cannot contain ".git" segments.`
		default: {
			const exhaustive: never = reason
			throw new Error(`Unsupported repo path denial: ${String(exhaustive)}`)
		}
	}
}

export function buildRepoSearchInvalidRegexCallerMessage(
	compileMessage: string,
) {
	return (
		`${repoSearchInvalidRegexMessagePrefix}: ${compileMessage}. ` +
		'mode=regex uses JavaScript RegExp syntax (no inline flags like (?s) or (?i); ' +
		'for dotall matching use [\\s\\S] instead of `.` with (?s)).'
	)
}

/**
 * Structural delete/move validation thrown by RepoSession DO
 * `applyWorkspaceEdits`. Agents guess paths (`index.ts`, `src/index.js`)
 * before listing the tree. Those misses are caller-correctable, and a
 * missing delete target stays an error. Subclass identity does not survive
 * Durable Object RPC, so MCP observability matches these phrases. KODY-9B.
 *
 * Quoted-path phrases require the path to sit between one pair of double
 * quotes, so unrelated "was not found" errors (Source, Manifest, Saved
 * package, repo tree) stay platform-visible.
 */
function matchesQuotedRepoSessionPath(
	message: string,
	prefix: string,
	suffix: string,
) {
	if (!message.startsWith(prefix) || !message.endsWith(suffix)) return false
	const path = message.slice(prefix.length, message.length - suffix.length)
	return path.length > 0 && !path.includes('"')
}

const repoSessionDeleteTargetPrefix = 'repo session delete edit target "'
const repoSessionMoveSamePathPrefix =
	'repo session move edit source and destination are the same: "'
const repoSessionMoveDuplicateDestinationPrefix =
	'repo session move edits cannot target the same destination twice: "'
const repoSessionMoveSourcePrefix = 'repo session move edit source "'
const repoSessionMoveDestinationPrefix = 'repo session move edit destination "'
const repoSessionMixedEditPrefix =
	'repo session edits cannot combine a delete/move touching "'
const repoSessionMixedEditSuffix =
	'" with a write/replace/writeJson edit for the same path in one call. Split them into separate repoEditFiles calls.'

export function isRepoSessionStructuralEditCallerMessage(message: string) {
	if (message === 'repo session delete edits require path.') return true
	if (message === 'repo session move edits require path and to.') return true
	if (
		matchesQuotedRepoSessionPath(
			message,
			repoSessionDeleteTargetPrefix,
			'" was not found.',
		)
	) {
		return true
	}
	if (
		matchesQuotedRepoSessionPath(message, repoSessionMoveSamePathPrefix, '".')
	) {
		return true
	}
	if (
		matchesQuotedRepoSessionPath(
			message,
			repoSessionMoveDuplicateDestinationPrefix,
			'".',
		)
	) {
		return true
	}
	if (
		matchesQuotedRepoSessionPath(
			message,
			repoSessionMoveSourcePrefix,
			'" was not found.',
		)
	) {
		return true
	}
	if (
		matchesQuotedRepoSessionPath(
			message,
			repoSessionMoveDestinationPrefix,
			'" already exists.',
		)
	) {
		return true
	}
	return matchesQuotedRepoSessionPath(
		message,
		repoSessionMixedEditPrefix,
		repoSessionMixedEditSuffix,
	)
}

/**
 * Stable phrases when a read/write/replace/writeJson/delete/move/applyPatch
 * target is an existing directory (`src` instead of `src/index.ts`). Agents
 * often pass a folder from `repoTree`; the shell then throws raw `EISDIR`,
 * which is caller-correctable. Subclass identity does not survive Durable
 * Object RPC, so MCP observability and capabilities match these phrases.
 * KODY-A6, KODY-CA (repoReadFile).
 */
export const repoSessionDirectoryTargetGuidance =
	'Pass a file path (for example src/index.ts), not a folder.'

export const repoSessionDirectoryTargetMessagePhrase =
	'is a directory. Pass a file path'

export type RepoSessionDirectoryTargetKind =
	| 'read'
	| 'write'
	| 'replace'
	| 'writeJson'
	| 'applyPatch'
	| 'move'
	| 'delete'

const repoSessionDirectoryTargetSuffix = `" is a directory. ${repoSessionDirectoryTargetGuidance}`

const repoSessionReadTargetPrefix = 'repo session read target "'

const repoSessionReadDirectoryTargetSuffix =
	'" is a directory. Pass a file path (for example src/index.ts), or use repoTree to list the folder.'

export function buildRepoSessionDirectoryTargetMessage(
	kind: RepoSessionDirectoryTargetKind,
	path: string,
) {
	switch (kind) {
		case 'read':
			return `${repoSessionReadTargetPrefix}${path}${repoSessionReadDirectoryTargetSuffix}`
		case 'write':
			return `repo session write edit target "${path}${repoSessionDirectoryTargetSuffix}`
		case 'replace':
			return `repo session replace edit target "${path}${repoSessionDirectoryTargetSuffix}`
		case 'writeJson':
			return `repo session writeJson edit target "${path}${repoSessionDirectoryTargetSuffix}`
		case 'applyPatch':
			return `repo session apply patch target "${path}${repoSessionDirectoryTargetSuffix}`
		case 'move':
			return `repo session move edit source "${path}${repoSessionDirectoryTargetSuffix}`
		case 'delete':
			return `repo session delete edit target "${path}${repoSessionDirectoryTargetSuffix}`
		default: {
			const exhaustive: never = kind
			throw new Error(
				`Unsupported directory target kind: ${String(exhaustive)}`,
			)
		}
	}
}

export function isRepoSessionDirectoryTargetCallerMessage(message: string) {
	if (!message.includes(repoSessionDirectoryTargetMessagePhrase)) return false
	return (
		matchesQuotedRepoSessionPath(
			message,
			repoSessionReadTargetPrefix,
			repoSessionReadDirectoryTargetSuffix,
		) ||
		matchesQuotedRepoSessionPath(
			message,
			'repo session write edit target "',
			repoSessionDirectoryTargetSuffix,
		) ||
		matchesQuotedRepoSessionPath(
			message,
			'repo session replace edit target "',
			repoSessionDirectoryTargetSuffix,
		) ||
		matchesQuotedRepoSessionPath(
			message,
			'repo session writeJson edit target "',
			repoSessionDirectoryTargetSuffix,
		) ||
		matchesQuotedRepoSessionPath(
			message,
			'repo session apply patch target "',
			repoSessionDirectoryTargetSuffix,
		) ||
		matchesQuotedRepoSessionPath(
			message,
			repoSessionMoveSourcePrefix,
			repoSessionDirectoryTargetSuffix,
		) ||
		matchesQuotedRepoSessionPath(
			message,
			repoSessionDeleteTargetPrefix,
			repoSessionDirectoryTargetSuffix,
		)
	)
}

/**
 * Raw `@cloudflare/shell` EISDIR wording (`EISDIR: /session/src is a
 * directory`, `EISDIR: cannot write to root directory`). Remap inside the
 * DO so callers never see the opaque form; also recognize it after RPC for
 * in-flight DO builds that still escape.
 */
export function isRawWorkspaceEisdirMessage(message: string) {
	return message.includes('EISDIR')
}

/**
 * Pull the workspace-relative path from a raw shell EISDIR message when
 * present (`EISDIR: /session/src is a directory` → `src`).
 */
export function externalPathFromRawWorkspaceEisdirMessage(
	message: string,
	workspacePrefix: string,
): string | null {
	// `@cloudflare/shell` preserves the failing path; allow spaces so a
	// target like `src/my file.ts` still extracts before the fixed trailer.
	const match = /^EISDIR:\s+(.+)\s+is a directory$/.exec(message)
	if (!match) return null
	const absolutePath = match[1]!
	if (absolutePath === workspacePrefix) return '.'
	if (absolutePath.startsWith(`${workspacePrefix}/`)) {
		return absolutePath.slice(workspacePrefix.length + 1)
	}
	return absolutePath.replace(/^\//, '')
}

/**
 * Stable prefix for `repoApplyPatch` / `applyUnifiedDiff` caller failures.
 * Agents send malformed or non-applying unified diffs; those are
 * caller-correctable. Subclass identity does not survive Durable Object RPC,
 * so MCP observability and the capability match this prefix (including
 * `diff` parse details rethrown as `git apply patch is malformed: …`).
 * KODY-A3 / KODY-A4.
 *
 * Also match raw `diff` parse phrases that can still escape without the
 * prefix (in-flight DO builds, or a forgotten wrap) so they stay off Sentry.
 * The legacy `git apply patch: …` form from the first wrap stays matched via
 * the shared prefix.
 */
export const repoApplyPatchCallerMessagePrefix = 'git apply patch'

export const repoApplyPatchMalformedGuidance =
	'Hunk header line counts (the numbers after @@) must match the hunk body.'

export function isRepoSessionApplyPatchCallerMessage(message: string) {
	if (message.startsWith(repoApplyPatchCallerMessagePrefix)) return true
	// Raw `diff` package parsePatch errors (see node_modules/diff patch/parse).
	if (message.startsWith('Hunk at line ')) return true
	if (message.startsWith('Added line count did not match for hunk at line ')) {
		return true
	}
	if (
		message.startsWith('Removed line count did not match for hunk at line ')
	) {
		return true
	}
	if (
		message.startsWith('Missing "') &&
		message.includes('" file header for ')
	) {
		return true
	}
	return false
}

export function buildRepoApplyPatchParseCallerMessage(parseMessage: string) {
	return `${repoApplyPatchCallerMessagePrefix} is malformed: ${parseMessage}. ${repoApplyPatchMalformedGuidance}`
}
