import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	isCloudflareOpaqueInternalError,
	isCloudflareOpaqueInternalErrorMessage,
} from '#worker/cloudflare-opaque-internal-error.ts'
import { loadPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	requiresPrivateVisibilityConfirmation,
	type PackagePrivateFieldValue,
	parsePackagePrivateField,
} from '#worker/package-registry/package-private.ts'
import {
	type ArtifactRepoHandle,
	type ArtifactToken,
	resolveArtifactDefaultBranchHead,
	resolveExistingArtifactSourceRepo,
} from './artifacts.ts'
import { isArtifactsGitTimeoutError } from './artifacts-git-retry.ts'
import type { EntitySourceRow } from './types.ts'

export const productionPackageSourceSafetyPolicy =
	'Production package source safety policy: never replace source history, force publish, or packageSave over an existing package unless Kody has created a restorable backup snapshot and the user explicitly approved destructive overwrite. If existing source cannot be cloned or verified, stop and report the source recovery problem.'

export const defaultPackagePrivateGuidance =
	'Visibility is a repo setting (`packageUpdate` / `repoUpdate`), not package.json `"private"`. Leftover `"private"` in manifests is ignored for catalog listing. New packages are created private; set `changes.visibility: "public"` after the user asks to list them on /community.'

export const destructiveOverwriteConfirmationField =
	'confirm_destructive_overwrite'

export const destructiveOverwriteConfirmationDescription =
	'Set to true only when the user explicitly approved destructive overwrite of existing package source history. Promoting publishes replace advertised history with a new root commit (and drop leftover session refs); promotePublished:false stays additive. Restorable backups retain prior content — secret scrub of backups still needs packageDelete or an explicit purge.'

export const privateVisibilityChangeConfirmationField =
	'confirm_private_visibility_change'

export const privateVisibilityChangeConfirmationDescription =
	'Set to true only when the user explicitly approved changing package.json `"private"`. This flag does not change repo visibility: catalog listing is `packageUpdate` `changes.visibility`. Leftover `"private"` in manifests is ignored for the catalog.'

export function buildSourceRecoveryProblemMessage(input: {
	source: EntitySourceRow
	operation: string
	reason: string
}) {
	const publishedCommit = input.source.published_commit ?? 'none'
	return [
		`${input.operation} stopped by the production package source safety policy.`,
		`Kody could not verify a restorable backup snapshot for source "${input.source.id}" at published commit "${publishedCommit}": ${input.reason}`,
		'Stop and report this source recovery problem instead of rebuilding or overwriting the package in place.',
	].join(' ')
}

/**
 * True when a source-recovery message is specifically "Artifacts HEAD does not
 * match published_commit". That state is expected after a git-lane push before
 * `packagePublishExternalPush` (or the reconcile cron) lands — a caller
 * precondition, not a platform defect.
 */
export function isPublishedCommitHeadMismatchMessage(message: string) {
	return (
		message.includes('default branch HEAD') &&
		message.includes('does not match published commit')
	)
}

export function buildPublishedCommitHeadMismatchCallerMessage(
	recoveryMessage: string,
) {
	return [
		recoveryMessage,
		'Publish the current Artifacts HEAD with packagePublishExternalPush (or wait for the reconcile job), then retry.',
		'Repo sessions open from the published commit and refuse to start while unpublished remote commits are present.',
	].join(' ')
}

/**
 * Stable phrase for Artifacts git HEAD / listServerRefs timeouts. Distinct
 * from repository *lookup* timeouts (`resolveExistingArtifactSourceRepo`),
 * which never reached the git remote.
 */
export const artifactsGitReadTimeoutMessagePhrase =
	'timed out reading the Artifacts git remote.'

/**
 * Stable phrase for Artifacts repository lookup timeouts
 * (`resolveExistingArtifactSourceRepo` / binding `get` / REST). Not a git
 * protocol failure — do not suggest packageSave as a git-remote fallback.
 */
export const artifactsRepoLookupTimeoutMessagePhrase =
	'timed out looking up the Artifacts repository.'

export function buildArtifactsGitReadTimeoutMessage(input: {
	operation: string
	reason: string
}) {
	const lines = [
		`${input.operation} ${artifactsGitReadTimeoutMessagePhrase}`,
		'Retry the call.',
	]
	// packageSave is the authoring fallback for a hung packageGetGitRemote.
	// repoOpenSession has no overwrite lane, so that sentence would send an
	// agent away from the session it was opening.
	if (input.operation === 'packageGetGitRemote') {
		lines.push(
			'Package authoring can use packageSave when packageGetGitRemote keeps timing out.',
		)
	}
	lines.push(input.reason)
	return lines.join(' ')
}

export function buildArtifactsRepoLookupTimeoutMessage(input: {
	operation: string
	reason: string
}) {
	return [
		`${input.operation} ${artifactsRepoLookupTimeoutMessagePhrase}`,
		'Retry the call.',
		input.reason,
	].join(' ')
}

export function isArtifactsGitReadTimeoutMessage(message: string) {
	return (
		message.includes(artifactsGitReadTimeoutMessagePhrase) &&
		message.includes('Retry the call.')
	)
}

export function isArtifactsRepoLookupTimeoutMessage(message: string) {
	return (
		message.includes(artifactsRepoLookupTimeoutMessagePhrase) &&
		message.includes('Retry the call.')
	)
}

/**
 * Stable phrase for Artifacts REST opaque internal errors (KODY-8F). Same
 * retry-oriented class as `buildArtifactsGitReadTimeoutMessage` — not a
 * source-recovery problem. Matched by MCP observability and Sentry beforeSend.
 */
export const artifactsOpaqueInternalRetryMessagePhrase =
	'hit a transient Cloudflare Artifacts internal error.'

export function buildArtifactsOpaqueInternalErrorMessage(input: {
	operation: string
	reason: string
}) {
	const lines = [
		`${input.operation} ${artifactsOpaqueInternalRetryMessagePhrase}`,
		'Retry the call.',
	]
	if (input.operation === 'packageGetGitRemote') {
		lines.push(
			'Package authoring can use packageSave when packageGetGitRemote keeps hitting this Artifacts platform error.',
		)
	}
	lines.push(input.reason)
	return lines.join(' ')
}

export function isArtifactsOpaqueInternalRetryMessage(message: string) {
	return (
		message.includes(artifactsOpaqueInternalRetryMessagePhrase) &&
		message.includes('Retry the call.')
	)
}

/**
 * Source-safety recovery wraps whose reason is the bare opaque Cloudflare /
 * Artifacts internal-error sentence. Real recovery failures (missing
 * snapshot, HEAD mismatch, repo not found, …) stay unmatched so Sentry still
 * sees them. Backstop for paths that wrapped before the retry branch existed
 * (KODY-8F).
 */
export function isSourceRecoveryOpaqueInternalErrorMessage(message: string) {
	if (
		!message.includes('stopped by the production package source safety policy.')
	) {
		return false
	}
	if (!message.includes('Stop and report this source recovery problem')) {
		return false
	}
	const match =
		/at published commit "[^"]*": (.+) Stop and report this source recovery problem/.exec(
			message,
		)
	const reason = match?.[1]
	return (
		typeof reason === 'string' && isCloudflareOpaqueInternalErrorMessage(reason)
	)
}

function rethrowPublishedPackageSourceRepoArtifactsError(input: {
	source: EntitySourceRow
	operation: string
	error: unknown
	/**
	 * `repo-lookup` is `resolveExistingArtifactSourceRepo` (binding/REST).
	 * `git-head` is default-branch HEAD resolution (git remote / listServerRefs).
	 * Timeout wording must stay accurate so agents do not treat a lookup stall
	 * as a hung git remote.
	 */
	failure: 'repo-lookup' | 'git-head'
}): never {
	if (isArtifactsGitTimeoutError(input.error)) {
		const reason = getErrorMessage(input.error)
		throw new Error(
			input.failure === 'repo-lookup'
				? buildArtifactsRepoLookupTimeoutMessage({
						operation: input.operation,
						reason,
					})
				: buildArtifactsGitReadTimeoutMessage({
						operation: input.operation,
						reason,
					}),
			{ cause: input.error },
		)
	}
	if (isCloudflareOpaqueInternalError(input.error)) {
		throw new Error(
			buildArtifactsOpaqueInternalErrorMessage({
				operation: input.operation,
				reason: getErrorMessage(input.error),
			}),
			{ cause: input.error },
		)
	}
	throw new Error(
		buildSourceRecoveryProblemMessage({
			source: input.source,
			operation: input.operation,
			reason: getErrorMessage(input.error),
		}),
		{ cause: input.error },
	)
}

function buildDestructiveOverwriteConfirmationMessage(input: {
	source: EntitySourceRow
	operation: string
}) {
	return [
		`${input.operation} would overwrite existing package source "${input.source.id}".`,
		`Set ${destructiveOverwriteConfirmationField}: true only after the user explicitly approves destructive overwrite; Kody will also verify a restorable backup snapshot first.`,
	].join(' ')
}

/**
 * Stable phrase from the package source overwrite confirmation gate. Agents
 * must re-call with `confirm_destructive_overwrite: true` after explicit user
 * approval — caller-correctable, not a platform defect. Matched by MCP
 * observability so plain Errors from shared policy helpers stay off Sentry.
 */
export const destructiveOverwriteConfirmationMessagePhrase = `Set ${destructiveOverwriteConfirmationField}: true only after the user explicitly approves destructive overwrite`

export function isDestructiveOverwriteConfirmationMessage(message: string) {
	return (
		message.includes('would overwrite existing package source') &&
		message.includes(destructiveOverwriteConfirmationMessagePhrase)
	)
}

export async function assertRestorablePackageSourceSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	operation: string
}) {
	if (input.source.entity_kind !== 'package') {
		return null
	}
	if (!input.source.published_commit) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'the source has no published commit',
			}),
		)
	}
	let snapshot: Awaited<ReturnType<typeof loadPublishedSourceSnapshot>>
	try {
		snapshot = await loadPublishedSourceSnapshot({
			env: input.env,
			userId: input.userId,
			source: input.source,
		})
	} catch (error) {
		const message = getErrorMessage(error)
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: message,
			}),
			{ cause: error },
		)
	}
	if (!snapshot) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'no published source snapshot was found',
			}),
		)
	}
	if (
		typeof snapshot.files !== 'object' ||
		snapshot.files == null ||
		Array.isArray(snapshot.files)
	) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'the published source snapshot is missing or malformed',
			}),
		)
	}
	const files = snapshot.files
	const fileCount = Object.keys(files).length
	const manifestContent = files[input.source.manifest_path]
	if (fileCount === 0) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'the published source snapshot is empty',
			}),
		)
	}
	if (typeof manifestContent !== 'string' || manifestContent.trim() === '') {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: `the published source snapshot is missing manifest "${input.source.manifest_path}"`,
			}),
		)
	}
	return {
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		fileCount,
	}
}

export async function assertPublishedPackageSourceRepoHead(input: {
	env: Env
	source: EntitySourceRow
	operation: string
	requirePublishedCommitHead?: boolean
	accessToken?: {
		scope: 'read' | 'write'
		ttlSeconds: number
	}
}): Promise<{
	sourceId: string
	publishedCommit: string
	commit: string
	defaultBranch: string
	remote: string
	repo: ArtifactRepoHandle
	accessToken: ArtifactToken | null
} | null> {
	if (input.source.entity_kind !== 'package') {
		return null
	}
	if (!input.source.published_commit) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: 'the source has no published commit',
			}),
		)
	}
	let repo: ArtifactRepoHandle | null
	try {
		repo = await resolveExistingArtifactSourceRepo(
			input.env,
			input.source.repo_id,
		)
	} catch (error) {
		rethrowPublishedPackageSourceRepoArtifactsError({
			source: input.source,
			operation: input.operation,
			error,
			failure: 'repo-lookup',
		})
	}
	if (!repo) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: `artifact source repo "${input.source.repo_id}" was not found`,
			}),
		)
	}
	let head: Awaited<ReturnType<typeof resolveArtifactDefaultBranchHead>>
	let accessToken: ArtifactToken | null = null
	try {
		if (input.accessToken) {
			const [info, minted] = await Promise.all([
				repo.info(),
				repo.createToken(input.accessToken.scope, input.accessToken.ttlSeconds),
			])
			accessToken = minted
			head = await resolveArtifactDefaultBranchHead({
				repo,
				token: minted.plaintext,
				info,
			})
		} else {
			head = await resolveArtifactDefaultBranchHead({ repo })
		}
	} catch (error) {
		rethrowPublishedPackageSourceRepoArtifactsError({
			source: input.source,
			operation: input.operation,
			error,
			failure: 'git-head',
		})
	}
	if (!head) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: `artifact source repo "${input.source.repo_id}" default branch has no HEAD`,
			}),
		)
	}
	if (
		input.requirePublishedCommitHead === true &&
		head.commit !== input.source.published_commit
	) {
		throw new Error(
			buildSourceRecoveryProblemMessage({
				source: input.source,
				operation: input.operation,
				reason: `artifact source repo "${input.source.repo_id}" default branch HEAD "${head.commit}" does not match published commit "${input.source.published_commit}"`,
			}),
		)
	}
	return {
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		commit: head.commit,
		defaultBranch: head.defaultBranch,
		remote: head.remote,
		repo,
		accessToken,
	}
}

export async function assertPackageSourceOverwriteAllowed(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	operation: string
	confirmed?: boolean
}) {
	if (input.source.entity_kind !== 'package') {
		return null
	}
	if (input.confirmed !== true) {
		throw new Error(
			buildDestructiveOverwriteConfirmationMessage({
				source: input.source,
				operation: input.operation,
			}),
		)
	}
	return await assertRestorablePackageSourceSnapshot(input)
}

function describePackagePrivateField(
	value: PackagePrivateFieldValue | 'missing',
): string {
	if (value === true) return '"private": true'
	if (value === false) return '"private": false'
	return 'no "private" field'
}

function buildPrivateVisibilityChangeConfirmationMessage(input: {
	operation: string
	beforeContent: string | null | undefined
	afterContent: string
	isNewPackage: boolean
}) {
	const afterValue = parsePackagePrivateField(input.afterContent)
	const beforeValue =
		input.beforeContent == null
			? 'missing'
			: parsePackagePrivateField(input.beforeContent)
	if (input.isNewPackage) {
		return [
			`${input.operation} would create a package that is not private-only (${describePackagePrivateField(afterValue)}).`,
			`Set ${privateVisibilityChangeConfirmationField}: true only after the user explicitly approves changing package.json "private". This does not list the package on /community — use packageUpdate changes.visibility for that.`,
		].join(' ')
	}
	return [
		`${input.operation} would change package.json private visibility from ${describePackagePrivateField(beforeValue)} to ${describePackagePrivateField(afterValue)}.`,
		`Set ${privateVisibilityChangeConfirmationField}: true only after the user explicitly approves the visibility change.`,
	].join(' ')
}

/**
 * Stable phrase from the package.json `"private"` confirmation gate. Same
 * caller-correctable class as destructive overwrite confirmation.
 */
export const privateVisibilityChangeConfirmationMessagePhrase = `Set ${privateVisibilityChangeConfirmationField}: true only after the user explicitly approves`

export function isPrivateVisibilityChangeConfirmationMessage(message: string) {
	return message.includes(privateVisibilityChangeConfirmationMessagePhrase)
}

export function assertPackagePrivateVisibilityChangeAllowed(input: {
	beforeContent: string | null | undefined
	afterContent: string
	isNewPackage: boolean
	operation: string
	confirmed?: boolean
}) {
	if (
		!requiresPrivateVisibilityConfirmation({
			beforeContent: input.beforeContent,
			afterContent: input.afterContent,
			isNewPackage: input.isNewPackage,
		})
	) {
		return
	}
	if (input.confirmed !== true) {
		throw new Error(
			buildPrivateVisibilityChangeConfirmationMessage({
				operation: input.operation,
				beforeContent: input.beforeContent,
				afterContent: input.afterContent,
				isNewPackage: input.isNewPackage,
			}),
		)
	}
}

export async function loadPriorPackageManifestContent(input: {
	env: Env
	userId: string
	source: EntitySourceRow
}): Promise<string | null> {
	if (
		input.source.entity_kind !== 'package' ||
		!input.source.published_commit
	) {
		return null
	}
	const snapshot = await loadPublishedSourceSnapshot({
		env: input.env,
		userId: input.userId,
		source: input.source,
	})
	if (!snapshot) {
		return null
	}
	const manifestContent = snapshot.files[input.source.manifest_path]
	return typeof manifestContent === 'string' ? manifestContent : null
}
