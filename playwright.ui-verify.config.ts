import { defineConfig, devices } from '@playwright/test'
import e2eConfig from './playwright.config.ts'
import { uiVerifyPaths } from './e2e/ui-verify/paths.ts'
import { pinnedBrowserEndpoint } from './e2e/ui-verify/pinned-browser.ts'

const wsEndpoint = pinnedBrowserEndpoint()

/**
 * `npm run ui:verify`: the component gallery and key pages in light and dark,
 * desktop and mobile. Reuses the isolated E2E web server (fresh D1, seeded
 * users). See docs/contributing/ui-verify.md.
 */
export default defineConfig({
	testDir: './e2e/ui-verify',
	testMatch: '*.spec.ts',
	outputDir: uiVerifyPaths.testResults,
	snapshotPathTemplate: `${uiVerifyPaths.baselines}/{arg}{ext}`,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	forbidOnly: !!process.env.CI,
	timeout: process.env.CI ? 180_000 : 120_000,
	expect: {
		toHaveScreenshot: {
			animations: 'disabled',
			caret: 'hide',
			scale: 'css',
			// Anti-aliasing noise only. A moved border, colour, or radius
			// change is far above this.
			threshold: 0.2,
			maxDiffPixelRatio: 0.002,
		},
	},
	reporter: [['list'], ['./e2e/ui-verify/reporter.ts']],
	use: {
		baseURL: e2eConfig.use?.baseURL,
		storageState: e2eConfig.use?.storageState,
		trace: 'off',
		reducedMotion: 'reduce',
		// The pinned browser reaches the host's E2E server through the client.
		connectOptions: wsEndpoint
			? { wsEndpoint, exposeNetwork: '<loopback>' }
			: undefined,
	},
	webServer: e2eConfig.webServer,
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
