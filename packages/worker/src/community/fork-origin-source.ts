import { readPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { readArtifactTreeAtCommit } from '#worker/repo/artifact-file.ts'
import { readArtifactSourceSnapshot } from '#worker/repo/artifact-source-snapshot.ts'

export type ForkOriginSourceFiles = {
	files: Record<string, string>
	commit: string
	/** Where the tree came from. Never writes owner KV on recovery. */
	source:
		| 'listing-snapshot'
		| 'published-snapshot'
		| 'artifact-snapshot-api'
		| 'artifact-git-tree'
}

/**
 * Unique non-empty commits to try when resolving fork origin files.
 * Preferred (usually default-branch HEAD) first, then pinned / published
 * fallbacks so a missing HEAD-keyed KV snapshot can still hit the listing pin.
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
		// Try the next source / commit.
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
		// Fall through.
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
	} catch {
		// Commit may be absent from objects; try the next candidate.
	}
	return null
}

/**
 * Resolve the file tree a fork will copy. Public listing forks may already have
 * a community KV pin; both listing and private forks then try published KV, the
 * local mock snapshot API, and finally a shallow Artifacts git walk of the
 * **origin** repo only (platform credentials). Does not persist recovered trees
 * into the owner's published-source KV — that would mutate another account.
 *
 * When a listing pin exists, prefer upgrading to HEAD published/mock snapshots,
 * then keep the pin — skip the git walk (listing pin already has files).
 */
export async function resolveForkOriginSourceFiles(input: {
	env: Env
	sourceId: string | null | undefined
	repoId: string | null | undefined
	preferredCommit: string | null | undefined
	fallbackCommits?: Array<string | null | undefined>
	listingSnapshotFiles?: Record<string, string> | null
	listingSnapshotCommit?: string | null
}): Promise<ForkOriginSourceFiles | null> {
	const commits = forkOriginCommitCandidates({
		preferredCommit: input.preferredCommit,
		fallbackCommits: input.fallbackCommits,
	})
	const sourceId = input.sourceId?.trim() || null
	const repoId = input.repoId?.trim() || null
	const listingFiles = input.listingSnapshotFiles
	const listingCommit = input.listingSnapshotCommit?.trim() || null
	const hasListingPin =
		Boolean(listingFiles && Object.keys(listingFiles).length > 0) &&
		Boolean(listingCommit)

	if (sourceId) {
		for (const commit of commits) {
			const files = await readPublishedAtCommit({
				env: input.env,
				sourceId,
				commit,
			})
			if (files) {
				return {
					files,
					commit,
					source: 'published-snapshot',
				}
			}
		}
	}

	if (repoId) {
		for (const commit of commits) {
			const files = await readMockSnapshotAtCommit({
				env: input.env,
				repoId,
				commit,
			})
			if (files) {
				return {
					files,
					commit,
					source: 'artifact-snapshot-api',
				}
			}
		}
	}

	if (hasListingPin && listingFiles && listingCommit) {
		return {
			files: listingFiles,
			commit: listingCommit,
			source: 'listing-snapshot',
		}
	}

	// No listing pin and no KV/mock snapshot: rebuild from origin git objects
	// at preferred then fallback commits (same recovery as published-source).
	if (repoId) {
		for (const commit of commits) {
			const files = await readGitTreeAtCommit({
				env: input.env,
				repoId,
				commit,
			})
			if (files) {
				return {
					files,
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
