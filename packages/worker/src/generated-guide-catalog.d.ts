/**
 * Type declarations for the pre-generated guide catalog modules built by
 * `tools/build-guide-catalog-modules.ts` into `src/generated/` (gitignored).
 * The generated modules re-serialize `parseGuideMarkdown`/
 * `rewriteRelativeGuideLinks` output as JSON, so those types are
 * authoritative here too.
 *
 * This file intentionally has no top-level `import`/`export` so it stays a
 * global script: that makes each `declare module` block below a genuine
 * ambient module shorthand (used even before the generator has run), not a
 * module augmentation of an already-resolved module (which real static
 * imports of the plain-JS generated files would otherwise resolve to,
 * losing the declared types). The per-block `import` inside each ambient
 * module declaration is scoped to that block only.
 */

declare module '*/generated/guide-metadata.mjs' {
	import type { GuideMetadata } from '#worker/guides/guide-types.ts'

	export const guideMetadata: ReadonlyArray<GuideMetadata>
}

declare module '*/generated/guide-catalog.mjs' {
	import type { Guide } from '#worker/guides/guide-types.ts'

	export const guides: ReadonlyArray<Guide>
}
