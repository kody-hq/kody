import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { expect, test } from 'vitest'
import { requestSkipsAssetProbe } from './static-asset-probe.ts'

const publicDirectory = join(import.meta.dirname, '../public')

function listPublicFiles(directory: string): Array<string> {
	const files: Array<string> = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...listPublicFiles(path))
			continue
		}
		files.push(path)
	}
	return files
}

test('route-owned prefixes skip the ASSETS probe', () => {
	const pathnames = [
		'/account',
		'/account/billing',
		'/@acme',
		'/@acme/-/jobs',
		'/@acme/-/repositories',
		'/mcp',
		'/api/me',
		'/oauth/authorize',
		'/oauth/callback',
		'/connectors/legacy',
		'/login',
		'/docs/llms.txt',
	]
	expect(
		pathnames.filter((pathname) => !requestSkipsAssetProbe(pathname)),
	).toEqual([])
})

test('public files and client bundles still probe ASSETS', () => {
	const publicPaths = listPublicFiles(publicDirectory).map(
		(filePath) =>
			`/${relative(publicDirectory, filePath).split(sep).join('/')}`,
	)
	expect(publicPaths.length).toBeGreaterThan(10)
	const probedPaths = [
		...publicPaths,
		'/',
		'/styles.css',
		'/client-entry.js',
		'/assets/index-abc123.js',
		'/favicon.ico',
		'/og/kody-logo.png',
		'/fonts/bricolage-grotesque-latin.woff2',
		'/images/kody-mark.png',
	]
	expect(
		probedPaths.filter((pathname) => requestSkipsAssetProbe(pathname)),
	).toEqual([])
})

test('unknown document paths do not require an asset lookup or route registry', () => {
	expect(requestSkipsAssetProbe('/new-feature/page')).toBe(true)
	expect(requestSkipsAssetProbe('/@kent/-/activity')).toBe(true)
	expect(requestSkipsAssetProbe('/feature-scenes/packages.css')).toBe(false)
})
