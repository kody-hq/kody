/**
 * Shared copy and helpers for Artifacts remotes minted by
 * `packageGetGitRemote` / `repoGetGitRemote`.
 *
 * Default scope follows the caller's access (write when they can write, else
 * read). Explicit `scope` is honored; requesting write without write access is
 * denied with an actionable message.
 */
import { AuthorizationError } from '#worker/authorization/authorize.ts'

export const gitRemoteReadOnlyPushRejectedMessage =
	"this remote is read-only; request scope: 'write'"

export type GitRemoteAccessScope = 'read' | 'write'

/** Push endpoints: `POST …/git-receive-pack` and `GET …/info/refs?service=git-receive-pack`. */
export function isGitReceivePackUrl(url: string): boolean {
	const parsed = URL.parse(url)
	if (!parsed) return false
	return (
		/\/git-receive-pack$/i.test(parsed.pathname) ||
		parsed.searchParams.get('service')?.toLowerCase() === 'git-receive-pack'
	)
}

export function readOnlyGitRemotePushRejectedError(options?: {
	cause?: unknown
}): Error {
	return new Error(gitRemoteReadOnlyPushRejectedMessage, options)
}

/**
 * Map Artifacts (or proxy) auth failures on receive-pack to the actionable
 * read-only remote message agents should act on.
 */
export function mapGitRemotePushAuthFailure(input: {
	url: string
	statusCode: number
	cause?: unknown
}): Error | null {
	if (
		(input.statusCode === 401 || input.statusCode === 403) &&
		isGitReceivePackUrl(input.url)
	) {
		return readOnlyGitRemotePushRejectedError(
			input.cause === undefined ? undefined : { cause: input.cause },
		)
	}
	return null
}

/** Pick minted token scope from an optional request and the caller's write access. */
export function pickGitRemoteAccessScope(input: {
	requested: GitRemoteAccessScope | undefined
	canWrite: boolean
}): GitRemoteAccessScope {
	if (input.requested) return input.requested
	return input.canWrite ? 'write' : 'read'
}

export function enhanceGitRemoteWriteDenial(input: {
	error: AuthorizationError
	resourceLabel: string
	operation: 'packageGetGitRemote' | 'repoGetGitRemote'
	canRead: boolean
}): AuthorizationError {
	const kind = resourceKind(input.operation)
	const access = input.canRead
		? `You have read access to ${input.resourceLabel}, not write.`
		: `You do not have write access to ${input.resourceLabel}.`
	const next =
		kind === 'package'
			? input.canRead
				? `Call ${input.operation} again with scope: 'read' for a clone-only remote, ask an org Owner to grant package:write on this package, or if it is a public community package fork it with communityFork and work in your copy.`
				: `Ask an org Owner to grant package:write (or at least package:read) on this package, or if it is a public community package use communitySearch / communityFork instead of ${input.operation}.`
			: input.canRead
				? `Call ${input.operation} again with scope: 'read' for a clone-only remote, or ask an org Owner to grant package:write across this org (plain repos are not covered by a single-package grant).`
				: `Ask an org Owner to grant package:write (or at least package:read) across this org. Plain repos are not covered by a single-package grant.`
	return new AuthorizationError({
		code: input.error.code,
		permission: input.error.permission,
		orgId: input.error.orgId,
		resource: input.error.resource,
		mintScopes: input.error.mintScopes,
		message: `${access} Write access (package:write) is required to mint a write remote. ${next} (${input.error.message})`,
	})
}

export function enhanceGitRemoteReadDenial(input: {
	error: AuthorizationError
	resourceLabel: string
	operation: 'packageGetGitRemote' | 'repoGetGitRemote'
}): AuthorizationError {
	const kind = resourceKind(input.operation)
	const next =
		kind === 'package'
			? `An org Owner can grant package:read (or package:write). If this is a public community package, use communitySearch / communityFork instead of ${input.operation}.`
			: `An org Owner can grant package:read (or package:write) across this org. Plain repos are not covered by a single-package grant.`
	return new AuthorizationError({
		code: input.error.code,
		permission: input.error.permission,
		orgId: input.error.orgId,
		resource: input.error.resource,
		mintScopes: input.error.mintScopes,
		message: `Missing package:read on ${input.resourceLabel}. ${next} (${input.error.message})`,
	})
}

function resourceKind(
	operation: 'packageGetGitRemote' | 'repoGetGitRemote',
): 'package' | 'repo' {
	return operation === 'packageGetGitRemote' ? 'package' : 'repo'
}
