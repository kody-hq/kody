import type { Plugin } from 'esbuild'

/** Let esbuild fixtures use the same classic script that Vite emits as an asset. */
export const peleAsset: Plugin = {
	name: 'pele-asset',
	setup(build) {
		build.onResolve({ filter: /^pele\/global\?url$/ }, () => ({
			path: 'pele',
			namespace: 'pele-asset',
		}))
		build.onLoad({ filter: /.*/, namespace: 'pele-asset' }, () => ({
			contents: 'export default "/pele.js"',
		}))
	},
}
