import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'

/**
 * Vitest global setup for the node-unit pool: generates gitignored build
 * artifacts (worker-bundler modules under `packages/worker/.generated/`, guide
 * catalog under `packages/worker/src/generated/`) so `vitest run` works on a
 * fresh clone. The generators are stamped, so warm runs cost ~0 ms.
 */
export default async function setup() {
	await Promise.all([
		ensureWorkerBundlerModules(),
		ensureGuideCatalogModules(),
	])
}
