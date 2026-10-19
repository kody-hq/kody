import {
	buildHighlightTestService,
	buildJobsTestService,
} from './build-test-services.ts'
import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'

/**
 * Vitest global setup for the workers-unit pool: generates gitignored build
 * artifacts (worker-bundler modules, guide catalog) and builds the auxiliary
 * "kody-jobs-test" / "kody-highlight-test" worker bundles that serve the main
 * worker's JOBS and HIGHLIGHT service bindings inside the pool.
 */
export default async function setup() {
	await Promise.all([
		ensureWorkerBundlerModules(),
		ensureGuideCatalogModules(),
		buildJobsTestService(),
		buildHighlightTestService(),
	])
}
