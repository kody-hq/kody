import { defineConfig, devices } from '@playwright/test'

const hasExplicitBaseUrl = Boolean(process.env.PLAYWRIGHT_BASE_URL)
const defaultPlaywrightPort = '3847'
const baseURL =
	process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${defaultPlaywrightPort}`
const webServerCommand = `npm run e2e:web-server -- --port ${defaultPlaywrightPort}`

export default defineConfig({
	testDir: './e2e',
	// Vitest node-unit helpers live beside Playwright specs as
	// `*.node.test.ts`; do not treat them as Playwright tests.
	testIgnore: ['**/*.node.test.ts'],
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// CI runs `validate`, which executes unit, MCP, and Playwright suites
	// concurrently on one runner. The default 30s per-test budget flakes under
	// that resource contention (page.goto alone has been observed taking >30s).
	timeout: process.env.CI ? 60_000 : 30_000,
	// Every worker hits the same local D1 file (`.wrangler/state/e2e`) through
	// Wrangler and the `d1 execute` helpers. Parallel workers cause SQLITE_BUSY
	// and transient 500s during auth/admin flows.
	workers: 1,
	// CI shards upload blob reports; the Validate merge job runs
	// `playwright merge-reports` into one HTML artifact. Keep `github` for
	// per-shard annotations on the Actions UI.
	reporter: process.env.CI
		? [['blob', { outputDir: 'blob-report' }], ['github']]
		: 'list',
	use: {
		baseURL,
		trace: 'on-first-retry',
	},
	// When PLAYWRIGHT_BASE_URL is set, reuse that origin (targeted specs against
	// `dev:ensure`). Otherwise start an isolated e2e webServer on 3847 that
	// does not require killing a healthy local origin (#3731).
	webServer: {
		command: webServerCommand,
		url: `${baseURL}/health`,
		// The web server starts Vite (`CLOUDFLARE_ENV=test`) after D1
		// migrations and the Cloudflare mock. Startup still competes with
		// parallel unit workers during `validate`, and the default 60s budget
		// times out on 4-core CI runners. Both budgets also cover one 60s
		// mock-start retry (`startCloudflareMockWithRetry`).
		timeout: process.env.CI ? 300_000 : 150_000,
		reuseExistingServer: hasExplicitBaseUrl,
		env: {
			CLOUDFLARE_ENV: 'test',
			// Fatal wrangler exits land here; CI uploads this directory on E2E
			// failure (see validate.yml + e2e/web-server-liveness.ts).
			WRANGLER_LOG_PATH: './logs.local',
			// Keep wrangler's default incoming-body drain. Setting
			// WRANGLER_DISABLE_REQUEST_BODY_DRAINING=true recreates the
			// workers-sdk#5106 ProxyWorker "Network connection lost" race on
			// POST /auth and other JSON posts. Wrangler 4.131+ keeps
			// `Error inside ProxyWorker` request-scoped (workers-sdk#15252).
			// Wrangler 4.118+ enables local observability capture by default in
			// `wrangler dev`. The extra collector/tail services have crashed the
			// Playwright webServer mid-suite here; opt out for e2e stability.
			X_LOCAL_OBSERVABILITY: 'false',
			// Wrangler 4.127+ local explorer writes under `.wrangler/tmp` on
			// Cloud Agent / CI hosts, retriggers esbuild, and leaves
			// ProxyWorker in a pause/reload loop after Ready.
			X_LOCAL_EXPLORER: 'false',
			// Reduce ProxyWorker "Network connection lost" flakes under e2e load.
			WRANGLER_CI_DISABLE_CONFIG_WATCHING: 'true',
			// Overlay FS retriggers esbuild's native source-graph watcher after
			// the first compile (Friction #1789). wrangler-env honors this.
			WRANGLER_DISABLE_BUNDLE_WATCH: 'true',
		},
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
})
