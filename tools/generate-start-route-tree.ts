import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Generator, getConfig } from '@tanstack/router-generator'
import { isExecutedDirectly } from './node-runtime.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Same `srcDirectory` as `tanstackStart` in `vite.config.ts`. */
const startSrcDirectory = 'packages/worker/start'

export const startRouteTreePath = path.join(
	startSrcDirectory,
	'routeTree.gen.ts',
)

export const startRouteTreeCheckPath = path.join(
	startSrcDirectory,
	'routeTree.gen.check.ts',
)

/**
 * TanStack Start's Vite plugin appends this Register block. The bare
 * `@tanstack/router-generator` defaults omit it.
 */
export function startRouteTreeRegisterFooter() {
	return [
		`import type { getRouter } from './router.tsx'
import type { startInstance } from './start.ts'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
    config: Awaited<ReturnType<typeof startInstance.getOptions>>
  }
}`,
	]
}

function startRouteTreeGeneratorConfig(generatedRouteTree: string) {
	return getConfig(
		{
			target: 'react',
			routesDirectory: path.resolve(repoRoot, startSrcDirectory, 'routes'),
			generatedRouteTree: path.resolve(repoRoot, generatedRouteTree),
			routeTreeFileFooter: startRouteTreeRegisterFooter,
		},
		repoRoot,
	)
}

export async function generateStartRouteTree(
	generatedRouteTree = startRouteTreePath,
) {
	const generator = new Generator({
		config: startRouteTreeGeneratorConfig(generatedRouteTree),
		root: repoRoot,
	})
	await generator.run()
	return generatedRouteTree
}

if (isExecutedDirectly(import.meta.url)) {
	await generateStartRouteTree()
}
