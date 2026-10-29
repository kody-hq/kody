import { expect, test } from 'vitest'

// Exercise the installed plugin build, not a copy of the traversal.
const pluginEntry = import.meta.resolve('@tanstack/start-plugin-core')
const { buildStartManifest, createManifestAssetResolvers } = await import(
	/* @vite-ignore */ new URL(
		'start-manifest-plugin/manifestBuilder.js',
		pluginEntry,
	).href
)

function fixture() {
	const chunk = (
		fileName: string,
		imports: Array<string> = [],
		dynamicImports: Array<string> = [],
	) => ({
		fileName,
		isEntry: fileName === 'entry.js',
		imports,
		dynamicImports,
		css: [],
		routeFilePaths: [],
		hydrationIds: [],
	})
	const chunks = [
		chunk('entry.js', ['direct.js', 'peer.js']),
		chunk('direct.js', ['shared.js'], ['unmatched-route.js']),
		chunk('peer.js', ['shared.js']),
		chunk('shared.js', ['direct.js', 'deep.js']),
		chunk('deep.js'),
		chunk('unmatched-route.js', ['unmatched-helper.js']),
		chunk('unmatched-helper.js'),
	]
	return new Map(chunks.map((value) => [value.fileName, value]))
}

test('Start preloads the whole static graph once, including cycles, without unrelated lazy routes', () => {
	const chunks = fixture()
	const manifest = buildStartManifest({
		clientBuild: { entryChunkFileName: 'entry.js', chunksByFileName: chunks },
		routeTreeRoutes: { __root__: { filePath: '/src/routes/__root.tsx' } },
		basePath: '/__start/release/',
	})
	expect(manifest.routes.__root__.preloads).toEqual([
		'/__start/release/entry.js',
		'/__start/release/direct.js',
		'/__start/release/peer.js',
		'/__start/release/shared.js',
		'/__start/release/deep.js',
	])
})

test('preload caching does not truncate a cyclic subgraph or contaminate another entry', () => {
	const chunks = fixture()
	const resolver = createManifestAssetResolvers('/', chunks)
	expect(resolver.getChunkPreloads(chunks.get('shared.js'))).toEqual([
		'/shared.js',
		'/direct.js',
		'/deep.js',
	])
	expect(resolver.getChunkPreloads(chunks.get('entry.js'))).toEqual([
		'/entry.js',
		'/direct.js',
		'/peer.js',
		'/shared.js',
		'/deep.js',
	])
	expect(resolver.getChunkPreloads(chunks.get('shared.js'))).toEqual([
		'/shared.js',
		'/direct.js',
		'/deep.js',
	])
})

test('the optional graph preserves direct-only behavior for existing resolver callers', () => {
	const chunks = fixture()
	expect(
		createManifestAssetResolvers('/').getChunkPreloads(chunks.get('entry.js')),
	).toEqual(['/entry.js', '/direct.js', '/peer.js'])
})
