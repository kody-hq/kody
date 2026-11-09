import type { PublishBuildOrigin } from './policy.ts'

export type { PublishBuildStatus } from './publish-build-state.ts'

/**
 * Bump when the builder's output or the build document changes shape. The
 * server rejects documents from any other version so a stale CLI or daemon
 * cannot upload bundles the server would not build the same way.
 */
export const publishBuilderVersion = 2

export type PublishBuildFileEntry = {
	path: string
	size: number
	sha256: string
}

export type PublishBuildModuleEntry = {
	sha256: string
	size: number
	/** Content-addressed chunks (sha256 hex), in order, that make the module. */
	chunks: Array<string>
}

export type PublishBuildTargetEntry = {
	kind: string
	bundleKind: 'app' | 'app-client' | 'module' | 'importable-module'
	artifactName: string | null
	entryPoint: string
	mainModule: string
	modules: Record<string, PublishBuildModuleEntry>
}

/** What a builder seals: the tree it built and every target it produced. */
export type PublishBuildDocument = {
	builderVersion: number
	commit: string
	files: Array<PublishBuildFileEntry>
	targets: Array<PublishBuildTargetEntry>
	/** Builder timing, shown to the publisher; never trusted. */
	buildMs?: number
}

export type UploadedPublishBuildRef = {
	buildId: string
	communityListed: boolean
	origin: PublishBuildOrigin
	contextName: string | null
}

export type PersistUploadedPublishBuildResult =
	| { ok: true; targetCount: number; sampledTargetCount: number }
	| { ok: false; message: string }
