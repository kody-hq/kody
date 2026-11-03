/**
 * Every product choice publish offload makes, in one place, so changing an
 * answer is a one-line edit here. Labels match the open product questions on
 * the "Move package publish off worker isolate limits" card.
 *
 * Settled: 2B, 4A, 5C, 6A, 7B, 9B, 10A, 11B.
 * Still open (keep them here, easy to flip): 1/3 and 8.
 */

/**
 * 1/3 (open): offload is chosen per publish with `--build local|context`
 * (flag only). Set to true to also honor a per-package `publish.build`
 * setting, which a plain `git push` then follows.
 */
export const publishOffloadFollowsPackageSetting = false

/**
 * 8 (open): the CLI refuses unless HEAD is already pushed. Set to true to
 * have `kody package publish --build local` push HEAD itself (it still
 * refuses on uncommitted changes either way).
 */
export const cliPushesHeadBeforeLocalBuild = false

/** 2B: a TTY asks "build here now?"; agents and CI get commands + docs. */
export const offerLocalBuildPromptInTty = true

/** 4A: only contexts the publisher operates may build their packages. */
export const publishBuildContextsMustBeOperatedByPublisher = true

/**
 * 5C: a rejected upload reports the exact reason, the old version keeps
 * serving, and the message carries this hint. No silent cloud fallback.
 */
export const publishBuildRejectionHint =
	'The previously published version is still serving. Build again from a clean checkout of the pushed commit (`git status` shows no changes and HEAD matches the remote), then publish again.'

/**
 * 6A: a bundle built outside the worker may only inline packages the
 * publisher can write. Anything else fails clearly; runtime-linked
 * dependencies are a later option.
 */
export const externallyBuiltBundlesMayInlineOnlyWritablePackages = true

/**
 * 7B: offloaded builds lift the compute caps (CPU, memory, wall time) but
 * keep storage caps.
 */
export const publishOffloadLimits = {
	maxSourceBytes: 32 * 1024 * 1024,
	maxTargetBytes: 20 * 1024 * 1024,
	chunkBytes: 4 * 1024 * 1024,
	/** Build manifest + all target files, generous but bounded. */
	maxUploadBytes: 512 * 1024 * 1024,
	maxBlobsPerBuild: 4096,
	/** Execution-context publish builds get more room than a normal run. */
	contextMemoryMb: 2048,
	contextTimeoutMs: 10 * 60 * 1000,
} as const

/** Per-build upload ticket lifetime. */
export const publishBuildTicketTtlMs = 30 * 60 * 1000

/** T4: the context's clone token is read-only, one repo, about 5 minutes. */
export const publishBuildCloneTokenTtlSeconds = 300

/**
 * 9B: community-listed packages may offload, with a bigger server re-check
 * sample. The server rebuilds this many targets and compares hashes.
 */
export function serverRebuildSampleSize(input: { communityListed: boolean }) {
	return input.communityListed ? 3 : 1
}

/** 10A: local and context build compute is free; only verification meters. */
export const meterOffloadedBuildCompute = false

/** 11B: build origin is shown in package info and the publish result. */
export const showBuildOrigin = true

export type PublishBuildOrigin = 'cloud' | 'cli' | 'context'

export function describeBuildOrigin(input: {
	origin: PublishBuildOrigin
	contextName?: string | null
}) {
	if (input.origin === 'cli') return 'Built locally with the Kody CLI.'
	if (input.origin === 'context') {
		return input.contextName
			? `Built on execution context "${input.contextName}".`
			: 'Built on an execution context.'
	}
	return 'Built on Kody cloud.'
}

export const publishLargePackagesDocsUrl =
	'https://kody.codes/docs/publish-large-packages'
