import type { PublishBuildOrigin } from './policy.ts'
import type * as Schemas from './schemas.ts'

export type { PublishBuildStatus } from './publish-build-state.ts'

/**
 * Bump when the builder's output or the build document changes shape. The
 * server rejects documents from any other version so a stale CLI or daemon
 * cannot upload bundles the server would not build the same way.
 */
export const publishBuilderVersion = 2

export type PublishBuildFileEntry = typeof Schemas.PublishBuildFileEntry.Type

export type PublishBuildModuleEntry =
	typeof Schemas.PublishBuildModuleEntry.Type

/** Mutable `modules` so a builder can fill the record it seals. */
export type PublishBuildTargetEntry = Omit<
	typeof Schemas.PublishBuildTargetEntry.Type,
	'modules'
> & { modules: Record<string, PublishBuildModuleEntry> }

/** What a builder seals: the tree it built and every target it produced. */
export type PublishBuildDocument = typeof Schemas.PublishBuildDocument.Type

export type UploadedPublishBuildRef = {
	buildId: string
	origin: PublishBuildOrigin
	contextName: string | null
}

export type PersistUploadedPublishBuildResult =
	| { ok: true; targetCount: number }
	| { ok: false; message: string }
