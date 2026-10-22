import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { playwrightCacheRoot } from './control-kody/playwright-browsers.ts'
import {
	ensurePlaywrightChromium,
	playwrightChromiumInstallArgs,
} from './ensure-playwright-browser.ts'

test('Playwright Chromium install skips apt deps on GitHub Actions and keeps them locally', () => {
	expect(playwrightChromiumInstallArgs({ githubActions: true })).toEqual([
		'install',
		'chromium',
	])
	expect(playwrightChromiumInstallArgs({ githubActions: false })).toEqual([
		'install',
		'chromium',
		'--with-deps',
	])
})

test('ensure skips install when the browsers.json revision markers already exist', async () => {
	const homeDir = await mkdtemp(path.join(tmpdir(), 'playwright-ensure-'))
	const browsersJsonPath = path.join(homeDir, 'browsers.json')
	const cacheRoot = playwrightCacheRoot(homeDir)
	try {
		await writeFile(
			browsersJsonPath,
			JSON.stringify({
				browsers: [
					{
						name: 'chromium',
						revision: '1234',
						browserVersion: '151.0.7922.34',
					},
					{
						name: 'chromium-headless-shell',
						revision: '1234',
						browserVersion: '151.0.7922.34',
					},
				],
			}),
		)
		await mkdir(path.join(cacheRoot, 'chromium-1234'), { recursive: true })
		await writeFile(
			path.join(cacheRoot, 'chromium-1234', 'INSTALLATION_COMPLETE'),
			'',
		)
		await mkdir(path.join(cacheRoot, 'chromium_headless_shell-1234'), {
			recursive: true,
		})
		await writeFile(
			path.join(
				cacheRoot,
				'chromium_headless_shell-1234',
				'INSTALLATION_COMPLETE',
			),
			'',
		)
		expect(
			ensurePlaywrightChromium({
				homeDir,
				browsersJsonPath,
				platform: 'linux',
				githubActions: false,
				cloudAgent: true,
			}),
		).toBe(0)
	} finally {
		await rm(homeDir, { recursive: true, force: true })
	}
})
