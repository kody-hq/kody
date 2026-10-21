/**
 * `kody dev` bundles of `kody.app.entry`: same esbuild options as one-shot
 * local bundles, plus an in-memory source map (for mapping workerd stacks back
 * to `.ts`) and the list of input files (for the watcher's stat poll). Uses an
 * incremental esbuild context so rebuilds only reparse changed files.
 */

import * as esbuild from 'esbuild'
import { join, resolve } from 'node:path'
import {
	BundleError,
	bundleInputs,
	createBundleError,
	localBundleOptions,
} from '../local-bundle.js'

export { bundleInputs } from '../local-bundle.js'

export type DevBundle = {
	code: string
	/** Source map JSON with sources relative to the package root. */
	sourceMap: string | null
	/** Absolute paths of every non-node_modules input in the graph. */
	inputs: Array<string>
}

export type DevBundler = {
	build: () => Promise<DevBundle>
	dispose: () => Promise<void>
}

type DevBuildContext = esbuild.BuildContext<{ write: false; metafile: true }>

export function createDevBundler(input: {
	entryPath: string
	root: string
}): DevBundler {
	const entry = resolve(input.entryPath)
	const base = localBundleOptions(entry)
	const options = {
		...base,
		sourcemap: 'external',
		sourcesContent: false,
		metafile: true,
		// Never written (write: false); only anchors source map paths at the root.
		outfile: join(input.root, '__kody_dev_bundle.js'),
	} satisfies esbuild.BuildOptions
	const paths = { workingDir: base.absWorkingDir, displayRoot: input.root }
	let disposed = false
	let context: Promise<DevBuildContext> | null = null

	return {
		build: async () => {
			let result: esbuild.BuildResult<{ write: false; metafile: true }>
			try {
				// A context created after dispose would never be released and keeps Node alive.
				if (disposed) throw new Error('kody dev bundler was already disposed.')
				context ??= esbuild.context(options)
				result = await (await context).rebuild()
			} catch (error) {
				throw createBundleError(input.entryPath, error, paths)
			}
			return readBundle(result, base.absWorkingDir, input.entryPath)
		},
		dispose: async () => {
			disposed = true
			const current = context
			context = null
			await (await current?.catch(() => null))?.dispose()
		},
	}
}

export function readBundle(
	result: esbuild.BuildResult<{ metafile: true; write: false }>,
	workingDir: string,
	entryPath: string,
): DevBundle {
	const outputs = result.outputFiles ?? []
	const js = outputs.find((file) => file.path.endsWith('.js'))
	const map = outputs.find((file) => file.path.endsWith('.js.map'))
	if (!js) {
		throw new BundleError(
			`Could not bundle ${entryPath}: esbuild produced no output.`,
			[],
		)
	}
	return {
		code: js.text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'),
		sourceMap: map?.text ?? null,
		inputs: bundleInputs(result.metafile, workingDir),
	}
}
