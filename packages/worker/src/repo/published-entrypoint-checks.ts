import { hasTopLevelDefaultExport } from '#worker/module-source.ts'
import { repoBackedModuleEntrypointExportErrorMessage } from './repo-kody-execution.ts'

function readSourceFile(sourceFiles: Record<string, string>, path: string) {
	return sourceFiles[path] ?? sourceFiles[path.replace(/^\.\//, '')] ?? null
}

export function collectEntrypointsMissingDefaultExport(input: {
	snapshot: { read(path: string): string | null }
	targets: ReadonlyArray<{ path: string }>
}) {
	return [
		...new Set(
			input.targets
				.map((target) => target.path)
				.filter((path) => {
					const source = input.snapshot.read(path)
					return source != null && !hasTopLevelDefaultExport(source)
				}),
		),
	]
}

export function formatMissingDefaultExportMessage(
	paths: ReadonlyArray<string>,
) {
	return `${repoBackedModuleEntrypointExportErrorMessage} Missing default export in: ${paths
		.map((path) => `"${path}"`)
		.join(', ')}.`
}

/**
 * Structural preconditions for rebuilding an already-published runtime
 * entrypoint (export, subscription handler, or job) at invocation time.
 *
 * Invocation deliberately does NOT typecheck. Publish (and `kody dev check`,
 * which runs the same server checks) is the only authoring gate, so an
 * invocation can never fail on a check that publish did not run: a rebuild
 * re-bundles exactly the source publish accepted. Type-level contracts such
 * as `(params?: Record<string, unknown>) => unknown` have no runtime effect
 * (the runtime always passes a params object), so enforcing them only here
 * broke published packages retroactively.
 *
 * What remains are conditions under which execution would fail anyway: the
 * entrypoint must exist in the published snapshot and must have a default
 * export. Reporting them here gives a clear message instead of a bundler or
 * "default is not a function" failure.
 */
export function checkPublishedEntrypointsForRebuild(input: {
	sourceFiles: Record<string, string>
	entryPoints: ReadonlyArray<{ path: string }>
}): { ok: true } | { ok: false; message: string } {
	const missingEntryPoints = input.entryPoints
		.map((target) => target.path)
		.filter((path) => readSourceFile(input.sourceFiles, path) == null)
	if (missingEntryPoints.length > 0) {
		return {
			ok: false,
			message: `Package runtime entrypoint(s) are missing from the published source snapshot: ${missingEntryPoints
				.map((path) => `"${path}"`)
				.join(', ')}. Republish the package to restore them.`,
		}
	}
	const missingDefaultExports = collectEntrypointsMissingDefaultExport({
		snapshot: { read: (path) => readSourceFile(input.sourceFiles, path) },
		targets: input.entryPoints,
	})
	if (missingDefaultExports.length > 0) {
		return {
			ok: false,
			message: formatMissingDefaultExportMessage(missingDefaultExports),
		}
	}
	return { ok: true }
}
