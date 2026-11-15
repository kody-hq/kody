import { createRequire } from 'node:module'
import { expect, test } from 'vitest'
import { pinnedBrowserImage, pinnedBrowserRunArgs } from './pinned-browser.ts'

const { version } = createRequire(import.meta.url)(
	'@playwright/test/package.json',
)

test('pinned browser matches the installed Playwright and stays on loopback', () => {
	const args = pinnedBrowserRunArgs({ name: 'ui-verify', port: 4100 })
	expect(pinnedBrowserImage).toBe(
		`mcr.microsoft.com/playwright:v${version}-noble`,
	)
	expect(args).toContain(`playwright@${version}`)
	expect(args[args.indexOf('--publish') + 1]).toBe('127.0.0.1:4100:4100')
	expect(args.slice(args.indexOf('run-server'))).toEqual([
		'run-server',
		'--port',
		'4100',
		'--host',
		'0.0.0.0',
	])
})
