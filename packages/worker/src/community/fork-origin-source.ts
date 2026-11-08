import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { readArtifactTreeAtCommit } from '#worker/repo/artifact-file.ts'
import { isArtifactsGitTransientRemapError } from '#worker/repo/artifacts-git-retry.ts'
import { readArtifactSourceSnapshot } from '#worker/repo/artifact-source-snapshot.ts'
import {
	isCommunityForkResourceLimitCause,
	rethrowCommunityForkFailure,
} from './fork-resource-limit.ts'

export type ForkOriginSourceFiles = {
	files: Record<string, string>
	commit: string
	/** Where the tree came from. Never writes owner KV on recovery. */
	source: 'published-snapshot' | 'artifact-snapshot-api' | 'artifact-git-tree'
}

/**
 * Unique non-empty commits to try when resolving fork origin files.
 * Preferred (usually default-branch HEAD) first, then pinned / published
 * fallbacks so a missing HEAD snapshot can still use the listing pin's.
 */
export function forkOriginCommitCandidates(input: {
	preferredCommit: string | null | undefined
	fallbackCommits?: Array<string | null | undefined>
}): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of [input.preferredCommit, ...(input.fallbackCommits ?? [])]) {
		const commit = typeof raw === 'string' ? raw.trim() : ''
		if (!commit || seen.has(commit)) continue
		seen.add(commit)
		out.push(commit)
	}
	return out
}

async function readPublishedAtCommit(input: {
	env: Env
	sourceId: string
	commit: string
}): Promise<Record<string, string> | null> {
	try {
		const published = await readPublishedSourceSnapshot({
			env: input.env,
			sourceId: input.sourceId,
			publishedCommit: input.commit,
		})
		if (published?.files && Object.keys(published.files).length > 0) {
			return published.files
		}
	} catch {
		// Try the next source for this commit.
	}
	return null
}

async function readMockSnapshotAtCommit(input: {
	env: Env
	repoId: string
	commit: string
}): Promise<Record<string, string> | null> {
	try {
		const treeSnapshot = await readArtifactSourceSnapshot({
			env: input.env,
			repoId: input.repoId,
			commit: input.commit,
		})
		if (treeSnapshot?.files && Object.keys(treeSnapshot.files).length > 0) {
			return treeSnapshot.files
		}
	} catch {
		// Fall through to git for this commit.
	}
	return null
}

async function readGitTreeAtCommit(input: {
	env: Env
	repoId: string
	commit: string
}): Promise<Record<string, string> | null> {
	try {
		const files = await readArtifactTreeAtCommit({
			env: input.env,
			repoId: input.repoId,
			commit: input.commit,
		})
		if (files && Object.keys(files).length > 0) {
			return files
		}
		return null
	} catch (error) {
		// Missing commit / empty tree: try the next candidate. Transient
		// Artifacts HTTP and isolate memory limits must stay 503 / resource
		// errors — do not mask them as a missing snapshot.
		if (
			isCommunityForkResourceLimitCause(error) ||
			isArtifactsGitTransientRemapError(error)
		) {
			rethrowCommunityForkFailure(error)
		}
		return null
	}
}

/**
 * Resolve the file tree a fork will copy. For each candidate commit (HEAD /
 * preferred first), try published KV, then the mock snapshot API, then a
 * shallow Artifacts git walk before moving on. That way a pin-keyed snapshot
 * never wins over a recoverable HEAD tree (website installs bind
 * `expectedPinnedCommit` to HEAD). Does not persist recovered trees into
 * another account's published-source KV.
 */
export async function resolveForkOriginSourceFiles(input: {
	env: Env
	sourceId: string | null | undefined
	repoId: string | null | undefined
	preferredCommit: string | null | undefined
	fallbackCommits?: Array<string | null | undefined>
}): Promise<ForkOriginSourceFiles | null> {
	const commits = forkOriginCommitCandidates({
		preferredCommit: input.preferredCommit,
		fallbackCommits: input.fallbackCommits,
	})
	const sourceId = input.sourceId?.trim() || null
	const repoId = input.repoId?.trim() || null

	for (const commit of commits) {
		if (sourceId) {
			const published = await readPublishedAtCommit({
				env: input.env,
				sourceId,
				commit,
			})
			if (published) {
				return {
					files: published,
					commit,
					source: 'published-snapshot',
				}
			}
		}

		if (repoId) {
			const mock = await readMockSnapshotAtCommit({
				env: input.env,
				repoId,
				commit,
			})
			if (mock) {
				return {
					files: mock,
					commit,
					source: 'artifact-snapshot-api',
				}
			}

			const gitFiles = await readGitTreeAtCommit({
				env: input.env,
				repoId,
				commit,
			})
			if (gitFiles) {
				return {
					files: gitFiles,
					commit,
					source: 'artifact-git-tree',
				}
			}
		}
	}

	return null
}

export function missingCommunityForkSnapshotMessage(listingId: string) {
	return `Catalog entry snapshot for "${listingId}" was not found and could not be recovered from the origin repository.`
}

export function missingPrivateForkSnapshotMessage(input: {
	packageId: string
	commit: string
}) {
	return `Source snapshot for package "${input.packageId}" at ${input.commit} was not found and could not be recovered from the origin repository.`
}
