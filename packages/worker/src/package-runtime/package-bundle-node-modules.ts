import {
	nodeModulesImportKind,
	resolveNodeModulesImport,
} from '@kody-internal/shared/node-modules-resolution.ts'
import { normalizeWorkspaceModulePath } from './module-graph-path-basics.ts'

/**
 * Product invariant: the platform never mounts third-party modules into a
 * package bundle. Bundler file sets may only include node_modules paths that
 * already exist in the package snapshot (publish-time install). Do not grow a
 * vendor denylist — refuse any injected node_modules path.
 */
export function assertNoPlatformSuppliedNodeModules(input: {
	snapshotFiles: Record<string, string>
	bundlerFiles: Record<string, string>
	bundleLabel: string
}) {
	const injected = Object.keys(input.bundlerFiles)
		.filter(
			(filePath) =>
				filePath.startsWith('node_modules/') &&
				!(filePath in input.snapshotFiles),
		)
		.sort((left, right) => left.localeCompare(right))
	if (injected.length === 0) return
	const preview = injected
		.slice(0, 8)
		.map((path) => `"${path}"`)
		.join(', ')
	const more = injected.length > 8 ? ` (and ${injected.length - 8} more)` : ''
	throw new Error(
		`${input.bundleLabel} includes node_modules paths the package snapshot does not contain (${preview}${more}). Kody does not supply third-party modules to package bundles; declare and install dependencies in the package instead.`,
	)
}

export function listNodeModulesPackageRoots(
	files: Record<string, string>,
): Array<string> {
	const roots = new Set<string>()
	for (const filePath of Object.keys(files)) {
		if (!filePath.startsWith('node_modules/')) continue
		const rest = filePath.slice('node_modules/'.length)
		const segments = rest.split('/')
		if (segments[0]?.startsWith('@') && segments.length >= 2) {
			roots.add(`${segments[0]}/${segments[1]}`)
			continue
		}
		if (segments[0]) roots.add(segments[0])
	}
	return [...roots].sort((left, right) => left.localeCompare(right))
}

type NodeModulesResolveArgs = {
	path: string
	resolveDir?: string
	kind: string
}

type NodeModulesResolveResult =
	| { path: string; namespace: 'virtual' }
	| { errors: Array<{ text: string }> }
	| undefined

/**
 * Resolves bare npm imports from the importing file's directory (nested
 * `node_modules` first), the same way the local CLI bundle does. The worker
 * bundler's own lookup only reads the root `node_modules/<name>`, so a
 * nested second major (e.g. `htmlparser2/node_modules/entities`) lost to
 * the hoisted one. Unknown packages fall through to the bundler unchanged.
 */
export function createNodeModulesResolutionPlugin(
	files: Record<string, string>,
) {
	const fs = {
		readFile: (path: string) => files[path] ?? null,
		fileExists: (path: string) => Object.hasOwn(files, path),
	}
	return {
		name: 'kody-node-modules-resolution',
		setup(build: {
			onResolve(
				options: { filter: RegExp },
				callback: (args: NodeModulesResolveArgs) => NodeModulesResolveResult,
			): void
		}) {
			build.onResolve({ filter: /^[^./]/ }, (args) => {
				if (args.kind === 'entry-point') return
				const resolution = resolveNodeModulesImport({
					specifier: args.path,
					importerDirectory: normalizeWorkspaceModulePath(
						args.resolveDir ?? '',
					),
					kind: nodeModulesImportKind(args.kind),
					fs,
				})
				if (resolution.kind === 'resolved') {
					return { path: resolution.path, namespace: 'virtual' }
				}
				if (resolution.kind === 'error') {
					return { errors: [{ text: resolution.message }] }
				}
				return undefined
			})
		},
	}
}
