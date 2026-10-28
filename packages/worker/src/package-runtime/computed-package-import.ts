import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { maxPackageRuntimeInvokeDepth } from '#worker/package-invocations/common.ts'
import {
	type BundleArtifactDependency,
	type PublishedBundleArtifact,
} from './published-runtime-artifacts.ts'
import { createRelativeImportSpecifier } from './module-graph-paths.ts'
import { resolveCurrentDynamicPackageArtifact } from './module-graph-hydration.ts'

/**
 * Nested depth budget for computed `kody:@` library loads. Matches the host
 * package-runtime invoke ceiling so a mutual computed-import cycle fails
 * closed instead of exhausting the isolate.
 */
export const maxComputedPackageImportDepth = maxPackageRuntimeInvokeDepth

export const computedPackageImportCallEntryPath =
	'.__kody_virtual__/computed-import-call.js'

export type ComputedPackageImportCallInput = {
	specifier: string
	params?: Record<string, unknown>
}

export type ComputedPackageImportTools = {
	callDefault: (input: ComputedPackageImportCallInput) => Promise<unknown>
}

/**
 * Build a one-shot callable entry over an importable-module artifact so the
 * host can evaluate the callee's default export with library-load semantics
 * (caller's `packageContext`, callee stamp grants) in a nested WorkerLoader
 * graph. WorkerLoader graphs are immutable after start, so computed imports
 * cannot install into the parent isolate; this is the same-heap library
 * contract with an isolate hop.
 */
export function buildComputedPackageImportCallBundle(input: {
	artifact: PublishedBundleArtifact
	specifier: string
}): {
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	packageBindingRewrite?: number
} {
	const targetImport = createRelativeImportSpecifier(
		computedPackageImportCallEntryPath,
		input.artifact.mainModule,
	)
	const modules: WorkerLoaderModules = {
		...input.artifact.modules,
		[computedPackageImportCallEntryPath]: `
import userDefault from ${JSON.stringify(targetImport)};
export default async function __kodyComputedImportCall(params) {
	if (typeof userDefault !== 'function') {
		throw new Error(
			${JSON.stringify(
				`Computed kody:@ import ${JSON.stringify(input.specifier)} has no callable default export.`,
			)},
		);
	}
	return await userDefault(params);
}
`.trim(),
	}
	const dependencies = [...(input.artifact.dependencies ?? [])]
	const calleePackageId = input.artifact.packageContext?.packageId?.trim()
	if (
		calleePackageId &&
		!dependencies.some((dependency) => dependency.packageId === calleePackageId)
	) {
		dependencies.push({
			sourceId: input.artifact.sourceId,
			publishedCommit: input.artifact.publishedCommit,
			kodyId: input.artifact.packageContext?.kodyId ?? '',
			packageId: calleePackageId,
			packageName: undefined,
		})
	}
	return {
		mainModule: computedPackageImportCallEntryPath,
		modules,
		dependencies,
		...(input.artifact.packageBindingRewrite === undefined
			? {}
			: {
					packageBindingRewrite: input.artifact.packageBindingRewrite,
				}),
	}
}

export async function resolveComputedPackageImportArtifact(input: {
	env: Env
	baseUrl: string
	userId: string
	specifier: string
}) {
	return await resolveCurrentDynamicPackageArtifact(input)
}

export function throwComputedPackageImportFailure(input: {
	specifier: string
	error: unknown
}): never {
	const message = getErrorMessage(input.error)
	throw new Error(
		`Computed kody:@ import ${JSON.stringify(input.specifier)} failed: ${message}`,
		{ cause: input.error instanceof Error ? input.error : undefined },
	)
}
