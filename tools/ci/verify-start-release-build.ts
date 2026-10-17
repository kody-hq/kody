import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startReleaseBase } from '../vite-start-release.ts'

async function javascriptFiles(directory: string): Promise<Array<string>> {
	const entries = await readdir(directory, { withFileTypes: true })
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const file = path.join(directory, entry.name)
			return entry.isDirectory()
				? javascriptFiles(file)
				: entry.name.endsWith('.js')
					? [file]
					: []
		}),
	)
	return nested.flat()
}

/** Verify the actual Cloudflare output, including embedded Start manifest URLs. */
export async function verifyStartReleaseBuild(
	directory: string,
	release: string,
) {
	const base = startReleaseBase(release)
	if (base === '/') throw new Error('A release SHA is required')
	const client = path.resolve(directory, 'client')
	const server = path.resolve(directory, 'server')
	const config = JSON.parse(
		await readFile(path.join(server, 'wrangler.json'), 'utf8'),
	) as { assets?: { directory?: string } }
	if (
		!config.assets?.directory ||
		path.resolve(server, config.assets.directory) !== client
	) {
		throw new Error(
			'Cloudflare assets.directory must retain the emitted client root',
		)
	}
	const topLevel = await readdir(client)
	if (
		topLevel.some(
			(entry) =>
				!['__start', '.assetsignore', '_headers', '_redirects'].includes(entry),
		)
	) {
		throw new Error('Release assets escaped their namespace')
	}
	for (const file of [
		'page-init.js',
		'site.webmanifest',
		'fonts/wix-madefor-text-latin.woff2',
	]) {
		if (!(await stat(path.join(client, base.slice(1), file))).isFile())
			throw new Error(`Missing release public file: ${file}`)
	}
	const sources = (
		await Promise.all(
			(await javascriptFiles(server)).map((file) => readFile(file, 'utf8')),
		)
	).join('\n')
	if (!sources.includes(`${base}_serverFn/`))
		throw new Error('Server RPC namespace is missing')
	const assetPattern = new RegExp(`${base}assets/[A-Za-z0-9_.-]+`, 'g')
	const references = new Set(sources.match(assetPattern))
	if (references.size === 0)
		throw new Error('Start SSR manifest contains no release asset references')
	for (const reference of references) {
		if (!(await stat(path.join(client, reference.slice(1)))).isFile())
			throw new Error(`Missing SSR manifest asset: ${reference}`)
	}
	if (sources.includes('__VITE_PUBLIC_ASSET__')) {
		throw new Error(
			'Unresolved Vite public asset tokens escaped into JavaScript',
		)
	}
	const stylesheetReferences = [...references].filter((reference) =>
		reference.endsWith('.css'),
	)
	const stylesheets = (
		await Promise.all(
			stylesheetReferences.map((reference) =>
				readFile(path.join(client, reference.slice(1)), 'utf8'),
			),
		)
	).join('\n')
	if (
		!stylesheets.includes('@font-face') ||
		!stylesheets.includes(`${base}fonts/wix-madefor-text-latin.woff2`)
	) {
		throw new Error(
			'Start SSR manifest must load the root stylesheet with namespaced font URLs',
		)
	}
	return references.size
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
	const count = await verifyStartReleaseBuild(
		process.argv[2] ?? 'dist-start-release',
		process.env.KODY_START_RELEASE ?? '',
	)
	console.log(
		`Verified ${count} namespaced SSR manifest assets and release RPCs`,
	)
}
