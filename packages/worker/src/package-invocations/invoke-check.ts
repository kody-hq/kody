import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import type {
	PackageInvokeCheckResult,
	PackageInvokeContract,
	PackageInvokeInput,
} from '#mcp/run-kody-registry.ts'
import type { PackageExportProjection } from '#worker/package-registry/manifest.ts'
import { normalizeExportName } from './common.ts'
import {
	buildNormalizedPackageInvokeInput,
	parsePackageInvokeInput,
} from './input-parsing.ts'
import {
	ensureModuleArtifact,
	loadInvokeManifestBySourceId,
	resolvePackageModuleResolution,
	resolveSavedPackageBySpecifier,
} from './module-artifacts.ts'

function createPackageInvokeCheckFailure(input: {
	message: string
	problems: Array<string>
	contract?: Partial<PackageInvokeContract>
}): PackageInvokeCheckResult {
	return {
		ok: false,
		message: input.message,
		problems: input.problems,
		...(input.contract ? { contract: input.contract } : {}),
	}
}

function buildPackageInvokeCheckWarnings(input: {
	exportDetail: PackageExportProjection | null
	sourceLoadFailed: boolean
}) {
	const warnings = [
		'No machine-readable params schema is published for package exports; params were only validated as a JSON object.',
	]
	if (input.sourceLoadFailed) {
		warnings.push(
			'Source files could not be loaded for metadata extraction; description and type information may be incomplete.',
		)
	}
	if (!input.exportDetail?.typeDefinition) {
		warnings.push(
			'No function type definition was found for this export; callable shape could not be statically confirmed.',
		)
	}
	return warnings
}

/**
 * Everything the check phase already loaded that the invoke phase would
 * otherwise reload from D1/KV: the saved-package row, the current manifest,
 * the resolved module target, and the prepared bundle artifact.
 * Host invoke passes these straight into the invocation so one logical
 * call resolves its package exactly once.
 */
export type PackageInvokeCheckPreloads = {
	savedPackage: NonNullable<
		Awaited<ReturnType<typeof resolveSavedPackageBySpecifier>>
	>
	moduleArtifact: Awaited<ReturnType<typeof ensureModuleArtifact>>
}

export type PackageInvokeCheckOutcome = {
	result: PackageInvokeCheckResult
	preloads: PackageInvokeCheckPreloads | null
}

export type PackageInvokeCheckOperationName = 'packages.invoke'

export async function checkPackageInvokeForRuntimeWithPreloads(input: {
	env: Env
	baseUrl: string
	operationName: PackageInvokeCheckOperationName
	userId: string
	rawInput: PackageInvokeInput
	callerKind?: 'package' | 'execute'
	callingPackageId?: string | null
}): Promise<PackageInvokeCheckOutcome> {
	let request: ReturnType<typeof parsePackageInvokeInput>
	try {
		request = parsePackageInvokeInput(input.rawInput, input.operationName)
	} catch (error) {
		const message = getErrorMessage(error)
		return {
			result: createPackageInvokeCheckFailure({
				message,
				problems: [message],
			}),
			preloads: null,
		}
	}
	const exportName = normalizeExportName(request.exportName)
	const invoke = buildNormalizedPackageInvokeInput({ request, exportName })
	const savedPackage = await resolveSavedPackageBySpecifier({
		db: input.env.APP_DB,
		userId: input.userId,
		specifier: request.specifier,
	})
	if (!savedPackage) {
		const message = `Kody package specifier ${JSON.stringify(request.specifier)} could not be resolved in this org. To use a package from another org, communityFork it into this org and import the copy.`
		return {
			result: createPackageInvokeCheckFailure({
				message,
				problems: [message],
				contract: { exportName },
			}),
			preloads: null,
		}
	}
	const packageContract = {
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		sourceId: savedPackage.sourceId,
		exportName,
	}
	let manifestResult: Awaited<ReturnType<typeof loadInvokeManifestBySourceId>>
	try {
		manifestResult = await loadInvokeManifestBySourceId({
			env: input.env,
			userId: input.userId,
			sourceId: savedPackage.sourceId,
		})
	} catch (error) {
		const problem = `Could not load current package manifest: ${getErrorMessage(error)}`
		return {
			result: createPackageInvokeCheckFailure({
				message: problem,
				problems: [problem],
				contract: packageContract,
			}),
			preloads: null,
		}
	}
	let resolution: ReturnType<typeof resolvePackageModuleResolution>
	try {
		resolution = resolvePackageModuleResolution({
			manifest: manifestResult.manifest,
			selector: {
				kind: 'export',
				exportName,
			},
		})
	} catch (error) {
		const problem = getErrorMessage(error)
		return {
			result: createPackageInvokeCheckFailure({
				message: problem,
				problems: [problem],
				contract: {
					...packageContract,
					publishedCommit: manifestResult.source.published_commit ?? null,
				},
			}),
			preloads: null,
		}
	}
	let moduleArtifact: Awaited<ReturnType<typeof ensureModuleArtifact>>
	try {
		moduleArtifact = await ensureModuleArtifact({
			env: input.env,
			baseUrl: input.baseUrl,
			packageManifest: manifestResult,
			resolution,
			savedPackage,
			selector: {
				kind: 'export',
				exportName,
			},
			userId: input.userId,
		})
	} catch (error) {
		const problem = `Export "${exportName}" could not be prepared for invocation: ${getErrorMessage(error)}`
		return {
			result: createPackageInvokeCheckFailure({
				message: problem,
				problems: [problem],
				contract: {
					...packageContract,
					publishedCommit: manifestResult.source.published_commit ?? null,
					runtimeTarget: resolution.entryPoint,
				},
			}),
			preloads: null,
		}
	}
	const preloads: PackageInvokeCheckPreloads = {
		savedPackage,
		moduleArtifact,
	}
	return {
		result: {
			ok: true,
			invoke,
			contract: {
				...packageContract,
				publishedCommit: manifestResult.source.published_commit ?? null,
				runtimeTarget: resolution.entryPoint,
				description: null,
				typeDefinition: null,
				warnings: buildPackageInvokeCheckWarnings({
					exportDetail: null,
					sourceLoadFailed: false,
				}),
			},
		},
		preloads,
	}
}
