import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	defaultPlaywrightBrowsersJsonPath,
	inspectPlaywrightBrowsers,
	playwrightCacheRoot,
} from './playwright-browsers.ts'

const fixtureBrowsersJson = JSON.stringify({
	browsers: [
		{
			name: 'chromium',
			revision: '1234',
			installByDefault: true,
			browserVersion: '151.0.7922.34',
		},
		{
			name: 'chromium-headless-shell',
			revision: '1234',
			installByDefault: true,
			browserVersion: '151.0.7922.34',
		},
		{
			name: 'firefox',
			revision: '1538',
			installByDefault: true,
			browserVersion: '153.0',
		},
	],
})

test('doctor requires the browsers.json chromium revision, not any INSTALLATION_COMPLETE marker', async () => {
	const homeDir = await mkdtemp(path.join(tmpdir(), 'playwright-browsers-'))
	const browsersJsonPath = path.join(homeDir, 'browsers.json')
	const cacheRoot = playwrightCacheRoot(homeDir)
	const repoRoot = path.resolve(import.meta.dirname, '../..')
	try {
		const missingFile = inspectPlaywrightBrowsers({
			homeDir,
			browsersJsonPath,
		})
		expect(missingFile.ok).toBe(false)
		expect(missingFile.detail).toContain(browsersJsonPath)

		await writeFile(browsersJsonPath, '{')
		const unparseable = inspectPlaywrightBrowsers({
			homeDir,
			browsersJsonPath,
		})
		expect(unparseable.ok).toBe(false)
		expect(unparseable.detail).toContain(browsersJsonPath)

		await writeFile(browsersJsonPath, JSON.stringify({ browsers: [] }))
		expect(inspectPlaywrightBrowsers({ homeDir, browsersJsonPath }).ok).toBe(
			false,
		)

		await writeFile(browsersJsonPath, fixtureBrowsersJson)
		await writeMarker(cacheRoot, 'chromium-1208')
		await writeMarker(cacheRoot, 'chromium_headless_shell-1208')
		const stale = inspectPlaywrightBrowsers({ homeDir, browsersJsonPath })
		expect(stale.ok).toBe(false)
		expect(stale.detail).toContain('chromium-1234')
		expect(stale.detail).toContain('chromium_headless_shell-1234')
		expect(stale.detail).not.toContain('chromium-1208')

		await mkdir(path.join(cacheRoot, 'chromium-1234'), { recursive: true })
		await writeMarker(cacheRoot, 'chromium_headless_shell-1234')
		const missingChrome = inspectPlaywrightBrowsers({
			homeDir,
			browsersJsonPath,
		})
		expect(missingChrome.ok).toBe(false)
		expect(missingChrome.detail).toContain('chromium-1234')

		await writeMarker(cacheRoot, 'chromium-1234')
		const installed = inspectPlaywrightBrowsers({
			homeDir,
			browsersJsonPath,
		})
		expect(installed.ok).toBe(true)
		expect(installed.detail).toContain('chromium-1234')
		expect(installed.detail).toContain('chromium_headless_shell-1234')

		const catalog = JSON.parse(
			readFileSync(defaultPlaywrightBrowsersJsonPath(repoRoot), 'utf8'),
		) as { browsers: Array<{ name: string; revision: string }> }
		const revision = catalog.browsers.find(
			(browser) => browser.name === 'chromium',
		)?.revision
		const emptyHome = path.join(homeDir, 'empty-home')
		await mkdir(emptyHome)
		const realCatalog = inspectPlaywrightBrowsers({
			homeDir: emptyHome,
			browsersJsonPath: defaultPlaywrightBrowsersJsonPath(repoRoot),
		})
		expect(realCatalog.ok).toBe(false)
		expect(realCatalog.detail).toContain(`chromium-${revision}`)
		expect(realCatalog.detail).toContain(`chromium_headless_shell-${revision}`)
	} finally {
		await rm(homeDir, { recursive: true, force: true })
	}
})

async function writeMarker(cacheRoot: string, directory: string) {
	const browserDirectory = path.join(cacheRoot, directory)
	await mkdir(browserDirectory, { recursive: true })
	await writeFile(path.join(browserDirectory, 'INSTALLATION_COMPLETE'), '')
}

test('browser cache follows the host platform', () => {
	expect(playwrightCacheRoot('/home/test', 'linux')).toBe(
		path.join('/home/test', '.cache', 'ms-playwright'),
	)
	expect(playwrightCacheRoot('/Users/test', 'darwin')).toBe(
		path.join('/Users/test', 'Library', 'Caches', 'ms-playwright'),
	)
	expect(playwrightCacheRoot('C:\\Users\\test', 'win32')).toBe(
		path.join('C:\\Users\\test', 'AppData', 'Local', 'ms-playwright'),
	)
	expect(
		playwrightCacheRoot('C:\\Users\\test', 'win32', {
			USERPROFILE: 'C:\\Users\\test',
			LOCALAPPDATA: 'D:\\Local',
		}),
	).toBe(path.join('D:\\Local', 'ms-playwright'))
})
