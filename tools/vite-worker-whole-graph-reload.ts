import path from 'node:path'
import type { EnvironmentModuleNode, Plugin } from 'vite'

/**
 * Reloads a Worker environment's whole module graph when an HMR update touches
 * a component module, instead of letting Vite hot-swap it in place.
 *
 * Under `@cloudflare/vite-plugin` the virtual worker entry is a self-accepting
 * HMR boundary, so a change never dead-ends into Vite's own full reload: the
 * module runner re-imports the nearest boundary and re-evaluates only the
 * invalidated importer chain, while every module off that chain keeps its
 * state. `remix/component-hmr` also instruments every component module into its own
 * boundary. Both are fine for a browser tab and wrong for SSR: each evaluation
 * of a component module mints new component functions, and Remix keys
 * `handle.context` on component identity. A request rendered during the
 * multi-stage cascade Remix's component HMR produces (update → invalidate →
 * importer update → circular reload) mixed generations, `context.get()` came
 * back `undefined`, and SSR failed part-way through the document.
 *
 * So when the changed modules or any of their importers (up to the entry) are
 * such a boundary, this sends `full-reload`: the runner clears its evaluated
 * modules and re-imports the entry — one consistent graph per change, the same
 * model as a redeploy. Pure server chains (a handler, a data loader) have no
 * component identities to split and keep Vite's cheaper incremental update;
 * module-level side effects on that path must be idempotent (see
 * `registerFrame`). The client environment is untouched, so browser component
 * HMR keeps hot-swapping, and client-only files never reach a Worker
 * environment's `hotUpdate` with modules.
 */
export function workerWholeGraphReload({
	clientEnvironmentName = 'client',
}: { clientEnvironmentName?: string } = {}): Plugin {
	return {
		name: 'kody-worker-whole-graph-reload',
		apply: 'serve',
		hotUpdate: {
			order: 'post',
			handler({ file, modules }) {
				if (this.environment.name === clientEnvironmentName) return
				if (!touchesComponentBoundary(modules)) return
				const shortFile = path.relative(this.environment.config.root, file)
				this.environment.logger.info(
					`page reload ${shortFile} (whole worker graph)`,
					{ timestamp: true },
				)
				this.environment.hot.send({ type: 'full-reload', path: '*' })
				return []
			},
		},
	}
}

type ModuleGraphNode = Pick<
	EnvironmentModuleNode,
	'id' | 'isSelfAccepting' | 'importers'
>

/**
 * True when a changed module, or any module that would be re-evaluated because
 * it imports one, accepts its own HMR updates. The environment entry is the
 * one self-accepting root every chain ends at and does not count; a component
 * module always has importers.
 */
export function touchesComponentBoundary(
	modules: ReadonlyArray<ModuleGraphNode>,
): boolean {
	const seen = new Set<ModuleGraphNode>()
	const queue = [...modules]
	while (queue.length > 0) {
		const mod = queue.pop()!
		if (seen.has(mod)) continue
		seen.add(mod)
		if (mod.isSelfAccepting && mod.importers.size > 0) return true
		for (const importer of mod.importers) queue.push(importer)
	}
	return false
}
