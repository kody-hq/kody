/**
 * Visual baselines are only comparable when every machine rasterizes text the
 * same way. `npm run ui:verify` therefore screenshots through Chromium inside
 * the official Playwright image (same browser, fonts, and FreeType everywhere)
 * and connects to it from the host test runner.
 */
import { createRequire } from 'node:module'

const playwrightVersion: string = createRequire(import.meta.url)(
	'@playwright/test/package.json',
).version

export const pinnedBrowserImage = `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`

/** Set by tools/ui-verify.ts when the pinned browser is running. */
export const pinnedBrowserEndpointEnv = 'UI_VERIFY_WS_ENDPOINT'

export function pinnedBrowserEndpoint() {
	return process.env[pinnedBrowserEndpointEnv] || undefined
}

export const visualChecksSkippedNote = `Visual diffs skipped: Docker is not available, so screenshots would not match baselines rendered in ${pinnedBrowserImage}. Axe and keyboard checks still ran. Start Docker and rerun to compare against baselines; CI always runs them.`

export function pinnedBrowserRunArgs(input: { name: string; port: number }) {
	return [
		'run',
		'--detach',
		'--rm',
		'--init',
		'--ipc=host',
		'--name',
		input.name,
		'--publish',
		`127.0.0.1:${input.port}:${input.port}`,
		pinnedBrowserImage,
		'npx',
		'--yes',
		`playwright@${playwrightVersion}`,
		'run-server',
		'--port',
		String(input.port),
		'--host',
		'0.0.0.0',
	]
}
