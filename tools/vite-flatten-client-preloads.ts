import type { Plugin, PluginOption } from 'vite'

type ChunkGraph = Record<
	string,
	{ type: 'chunk'; imports: Array<string> } | { type: 'asset' }
>

const manifestCapturePluginName =
	'tanstack-start:start-manifest-capture-client-build'

/** Each chunk's full static import closure, direct imports first. */
function staticImportClosures(bundle: ChunkGraph) {
	const closures = new Map<string, Array<string>>()
	for (const [fileName, chunk] of Object.entries(bundle)) {
		if (chunk.type !== 'chunk') continue
		const ordered: Array<string> = []
		const seen = new Set([fileName])
		const queue = [fileName]
		while (queue.length > 0) {
			const current = bundle[queue.shift() as string]
			if (current?.type !== 'chunk') continue
			for (const imported of current.imports) {
				if (seen.has(imported)) continue
				seen.add(imported)
				ordered.push(imported)
				queue.push(imported)
			}
		}
		closures.set(fileName, ordered)
	}
	return closures
}

/** A view of the bundle whose chunks report their whole closure as `imports`. */
export function withFlattenedImports<Bundle extends ChunkGraph>(
	bundle: Bundle,
): Bundle {
	const closures = staticImportClosures(bundle)
	const view: ChunkGraph = {}
	for (const [fileName, entry] of Object.entries(bundle)) {
		const imports = closures.get(fileName)
		view[fileName] = imports
			? new Proxy(entry, {
					get: (target, property, receiver) =>
						property === 'imports'
							? imports
							: Reflect.get(target, property, receiver),
				})
			: entry
	}
	return view as Bundle
}

function flattenPlugins(option: PluginOption): Array<Plugin> {
	if (Array.isArray(option)) return option.flatMap(flattenPlugins)
	if (!option || typeof option !== 'object' || 'then' in option) return []
	return [option]
}

/**
 * TanStack Start builds root and route `modulepreload` links from
 * `chunk.imports`, which lists only direct imports, so deeper shared chunks
 * (the Zod schemas chunk, for example) were found one round trip late on a
 * cold visit. Hand its manifest capture a bundle view with each chunk's whole
 * static closure. Emitted code is untouched.
 */
export function flattenClientPreloads(option: PluginOption): Array<Plugin> {
	const plugins = flattenPlugins(option)
	const capture = plugins.find(
		(plugin) => plugin.name === manifestCapturePluginName,
	)
	const hook = capture?.generateBundle
	if (!capture || typeof hook !== 'function') {
		throw new Error(
			`${manifestCapturePluginName} not found; update tools/vite-flatten-client-preloads.ts`,
		)
	}
	capture.generateBundle = function (options, bundle, isWrite) {
		return hook.call(
			this,
			options,
			withFlattenedImports(bundle as unknown as ChunkGraph) as never,
			isWrite,
		)
	}
	return plugins
}
