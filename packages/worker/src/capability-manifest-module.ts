import type { capabilityManifest } from './mcp/capabilities/capability-manifest.generated.mjs'

/**
 * Loads the committed builtin capability manifest.
 *
 * Wrangler keeps a relative `import()` specifier as written and resolves it
 * against the bundled entry at the `src` root, while it uploads the manifest
 * at its path under `src`. This module lives at the `src` root so the two
 * agree, the same way `guide-catalog-modules.ts` loads the guide catalog.
 */
export function importCapabilityManifest(): Promise<{
	capabilityManifest: typeof capabilityManifest
}> {
	return import('./mcp/capabilities/capability-manifest.generated.mjs')
}
