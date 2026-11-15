import { createCacheEntry } from '@epic-web/cachified'
import { deferWork } from '#worker/deferred-work.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	isSnapshotOnlyArtifactsRemote,
	resolveExistingArtifactSourceRepo,
} from '#worker/repo/artifacts.ts'
import { runArtifactsGitWithRetry } from '#worker/repo/artifacts-git-retry.ts'
import { createEphemeralGitWorkspace } from '#worker/repo/ephemeral-git-workspace.ts'
import { loadIsomorphicGit } from '#worker/repo/isomorphic-git-lazy.ts'

/**
 * Commit ids hash their parents, so whether one SHA is in another's history
 * never changes and does not depend on which repo holds the commits. Definite
 * answers are cached per isolate and in KV, keyed by the SHA pair alone; the
 * TTLs only bound storage. `null` (graph unreadable) is never cached.
 */
const listingPinAncestryCache = new PromiseLruCache<boolean | null>({
	ttlMs: 24 * 60 * 60 * 1000,
})
const storedAncestryTtlMs = 30 * 24 * 60 * 60 * 1000

export function buildForkAncestryCacheKey(input: {
	ancestor: string
	descendant: string
}) {
	return `fork-ancestry:v1:${input.ancestor}:${input.descendant}`
}

function readAncestryKv(env: Env): KVNamespace | null {
	return (
		(env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined })
			.BUNDLE_ARTIFACTS_KV ?? null
	)
}

async function readStoredAncestry(env: Env, key: string) {
	const kv = readAncestryKv(env)
	if (!kv) return null
	const entry = await createKvCachifiedCache(kv).get(key)
	return typeof entry?.value === 'boolean' ? entry.value : null
}

function storeAncestry(env: Env, key: string, value: boolean) {
	const kv = readAncestryKv(env)
	if (!kv) return
	void deferWork('fork-ancestry-store-failed', async () => {
		await createKvCachifiedCache(kv).set(
			key,
			createCacheEntry(value, { ttl: storedAncestryTtlMs }),
		)
	})
}

/**
 * Whether the listing pin is the fork's absorb marker (`origin_commit`) or in
 * its history. Both SHAs live in the listing origin graph — the fork is a new
 * Artifacts repo and never contains the listing pin. Returns true when the pin
 * is the tip or an ancestor, false when the walk completes without it, and
 * null when the graph cannot be read (missing repo, loopback snapshot, or
 * fetch failure). `resolveOriginRepoId` only runs when no answer is cached.
 */
export async function listingPinIsAncestorOfForkTip(input: {
	env: Env
	listingPinnedCommit: string
	forkTip: string
	resolveOriginRepoId: () => Promise<string | null>
}): Promise<boolean | null> {
	const ancestor = input.listingPinnedCommit.trim()
	const descendant = input.forkTip.trim()
	if (ancestor.length === 0 || descendant.length === 0) return null
	if (ancestor === descendant) return true

	const cacheKey = buildForkAncestryCacheKey({ ancestor, descendant })
	const result = await listingPinAncestryCache.getOrCreate({
		cacheKey,
		async create() {
			const stored = await readStoredAncestry(input.env, cacheKey)
			if (stored !== null) return stored
			const repoId = await input.resolveOriginRepoId()
			if (!repoId) return null
			const walked = await walkOriginRepoAncestry({
				env: input.env,
				repoId,
				ancestor,
				descendant,
			})
			if (walked !== null) storeAncestry(input.env, cacheKey, walked)
			return walked
		},
	})
	if (result === null) listingPinAncestryCache.delete(cacheKey)
	return result
}

async function walkOriginRepoAncestry(input: {
	env: Env
	repoId: string
	ancestor: string
	descendant: string
}): Promise<boolean | null> {
	const repo = await resolveExistingArtifactSourceRepo(input.env, input.repoId)
	if (!repo) return null
	const info = await repo.info()
	if (!info?.remote) return null
	if (isSnapshotOnlyArtifactsRemote(input.env, info.remote)) return null

	const token = await repo.createToken('read', 300)
	const remote = buildAuthenticatedArtifactsRemote({
		remote: info.remote,
		token: token.plaintext,
	})
	const auth = buildArtifactsGitAuth({ token: token.plaintext })
	const { git, http } = await loadIsomorphicGit()
	try {
		return await runArtifactsGitWithRetry(async () => {
			const workspace = createEphemeralGitWorkspace()
			await git.init({
				fs: workspace.fs,
				dir: workspace.dir,
			})
			await git.addRemote({
				fs: workspace.fs,
				dir: workspace.dir,
				remote: 'origin',
				url: remote,
			})
			await git.fetch({
				fs: workspace.fs,
				http,
				dir: workspace.dir,
				remote: 'origin',
				ref: input.descendant,
				depth: Number.POSITIVE_INFINITY,
				singleBranch: true,
				tags: false,
				onAuth() {
					return auth
				},
			})
			const commits = await git.log({
				fs: workspace.fs,
				dir: workspace.dir,
				ref: input.descendant,
				depth: Number.POSITIVE_INFINITY,
			})
			return commits.some((commit) => commit.oid === input.ancestor)
		})
	} catch {
		return null
	}
}
