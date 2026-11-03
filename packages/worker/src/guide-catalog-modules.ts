import { guideMetadata } from './generated/guide-metadata.mjs'
import type { Guide, GuideMetadata } from './guides/guide-types.ts'

/**
 * Lazy access to the full guide catalog, generated from `docs/guides/` by
 * `tools/build-guide-catalog-modules.ts` into `./generated/` (gitignored).
 *
 * `guideMetadataList` is small (frontmatter only, no bodies) and safe to
 * statically import: it costs no per-guide parsing at runtime and adds
 * negligible size to whichever Worker ranks `guide:{id}` search entities
 * or registers `codingGuideGet`.
 *
 * `importGuideCatalog()` returns the full parsed catalog (bodies included).
 * An ordinary dynamic `import()` of an in-repo module — e.g. one that walked
 * the same markdown/TS import graph as `#worker/guides/catalog.ts` — still
 * gets bundled into the single main worker script by Wrangler, so V8 must
 * parse and link that extra code on every isolate cold start even though its
 * *execution* stays deferred until the `import()` call runs. The generated
 * `./generated/guide-catalog.mjs` file stays behind `import()`, so Vite
 * origin emits it as a hashed SSR chunk and Wrangler sibling workers still
 * match the allowlisted `generated/guide-catalog.mjs` find_additional_modules
 * rule. Either way it is excluded from the main script and only fetched,
 * parsed, and evaluated
 * when a request actually opens a `guide:{id}` entity or calls the
 * `codingGuideGet` handler.
 * Merely ranking guide metadata does not add catalog parse/link cost to
 * the main module's cold start.
 */

export const guideMetadataList: ReadonlyArray<GuideMetadata> = guideMetadata

export function importGuideCatalog(): Promise<{
	guides: ReadonlyArray<Guide>
}> {
	return import('./generated/guide-catalog.mjs')
}
