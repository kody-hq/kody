/**
 * Every product choice publish offload makes, in one place, so changing an
 * answer is a one-line edit here. Labels match the product questions on the
 * "Move package publish off worker isolate limits" card.
 *
 * Settled: 1, 2B, 3, 4A, 5C, 6C, 7B, 8B, 9B, 10A, 11B.
 *
 * 1 (Kent, Nov 4 2026): a publish follows the publisher's execution context
 * chain like execute, a trigger can name a context, and a package's
 * `kody.publish.execution.context` is a binding with no fallback. See
 * `publish-routing.ts`.
 *
 * 3 (Kent, Nov 4 2026): no server-side push routing. Auto-publish on push is
 * a package subscribing to the repo pushed event and calling publish, which
 * then follows rule 1.
 */

/**
 * 8B: `kody package publish --build local` refuses uncommitted changes,
 * pushes HEAD to its upstream on the Kody remote when it is not there yet
 * (never committing), and builds only once Kody confirms it sees that
 * commit (`expected_commit` on `packagePublishBuildCreate`).
 */
export const cliPushesHeadBeforeLocalBuild = true

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
 * 6C: a bundle built outside the worker never inlines another Kody package.
 * Its `kody:@…` imports stay linked placeholders that Kody fills in at commit
 * time from each dependency's published artifact, resolved as the
 * publisher, so any package the publisher can import works.
 */
export const externallyBuiltBundlesLinkKodyPackageImports = true

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
 * How long a build's chunks outlive its upload ticket before the sweep that
 * runs when a build starts drops them (and the row, unless committed).
 */
export const publishBuildRetentionMs = 24 * 60 * 60 * 1000

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
