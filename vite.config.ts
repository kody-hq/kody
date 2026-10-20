import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { redact } from '@tanstack/redact/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import {
	collectLocalOriginDevVars,
	localGeneratedConfigBasename,
	writeLocalOriginDevConfig,
} from './tools/local-origin-dev-config.ts'
import { writeLocalAuxiliaryDevConfig } from './tools/local-auxiliary-dev-config.ts'
import { writeLocalSiblingDevConfig } from './tools/local-sibling-dev-config.ts'
import { resolveLocalD1PersistPath } from './tools/local-d1-persist.ts'
import { ensureGuideCatalogModules } from './tools/build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './tools/build-worker-bundler-modules.ts'
import { inlineCssText } from './tools/vite-inline-css-text.ts'
import { markdownAsText } from './tools/vite-markdown-as-text.ts'
import { workerWholeGraphReload } from './tools/vite-worker-whole-graph-reload.ts'

import {
	startReleaseAssets,
	startReleaseBase,
} from './tools/vite-start-release.ts'

const releaseBase = startReleaseBase(process.env.KODY_START_RELEASE)

const root = path.dirname(fileURLToPath(import.meta.url))
// `@cloudflare/vite-plugin` reads `CLOUDFLARE_ENV` itself (not this
// file's `envName`) to pick `env.production` / `env.test` bindings. Local
// `npm run dev` does not set the variable, so without this default the
// plugin loads the top-level wrangler config (no D1/DO/KV) and origin
// `/health` fails with Missing APP_DB.
const envName = process.env.CLOUDFLARE_ENV?.trim() || 'production'
if (!process.env.CLOUDFLARE_ENV?.trim()) {
	process.env.CLOUDFLARE_ENV = envName
}
const persistPath = resolveLocalD1PersistPath()
const wranglerConfigPath =
	process.env.KODY_WRANGLER_CONFIG ?? 'packages/worker/wrangler.jsonc'
const isOriginDeployBuild = Boolean(process.env.KODY_WRANGLER_CONFIG)

function alias(prefix: string, target: string) {
	return {
		find: new RegExp(`^${prefix}/`),
		replacement: `${target}/`,
	}
}

// Match tanstack.com's Worker setup: every server variant uses one runtime.
const redactServerAliases = [
	'react-dom/server',
	'react-dom/server.edge',
	'react-dom/server.node',
	'react-dom/server.bun',
	'react-dom/server.browser',
	'react-dom/static.edge',
	'react-dom/static.node',
	'react-dom/static',
].map((specifier) => ({
	find: new RegExp(`^${specifier.replaceAll('.', '\\.')}$`),
	replacement: '@tanstack/redact/server',
}))

export default defineConfig(async ({ command }) => {
	await ensureWorkerBundlerModules()
	await ensureGuideCatalogModules()

	const auxiliaryWorkers: Array<{
		configPath: string
		devOnly: true
	}> = []
	let serveWranglerConfigPath = wranglerConfigPath

	if (command === 'serve' && !isOriginDeployBuild) {
		// Vite's Cloudflare plugin reads Worker bindings from the Wrangler
		// config, not process env. Write the same local-dev vars wrangler-env
		// used to pass with `--var` so origin `env` still sees them.
		// E2E uses a separate generated basename so it cannot overwrite a
		// concurrent `dev:ensure` config on reload (#3731).
		const generatedBasename = localGeneratedConfigBasename(process.env)
		serveWranglerConfigPath = await writeLocalOriginDevConfig({
			originConfigPath: wranglerConfigPath,
			envName,
			vars: collectLocalOriginDevVars(process.env, process.env.PORT),
			generatedBasename,
			// Same always-remote strip as the platform sibling: keep the
			// committed production/preview `artifacts` binding for deploys,
			// but omit it from the generated local origin so `packageSave`
			// uses the mock Artifacts REST path instead of failing with
			// "Binding ARTIFACTS needs to be run remotely".
			dropAlwaysRemoteBindings: ['artifacts'],
		})
		if (process.env.KODY_E2E_WEB_SERVER === '1') {
			const { unstable_getVarsForDev } = await import('wrangler')
			const expected = collectLocalOriginDevVars(process.env, process.env.PORT)
			const resolved = unstable_getVarsForDev(
				serveWranglerConfigPath,
				undefined,
				expected,
				envName,
				true,
			)
			if (
				!expected.STRIPE_SECRET_KEY?.startsWith('sk_test_e2e_') ||
				resolved.STRIPE_SECRET_KEY?.value !== expected.STRIPE_SECRET_KEY ||
				resolved.STRIPE_API_BASE_URL?.value !== expected.STRIPE_API_BASE_URL
			) {
				throw new Error(
					'E2E Stripe configuration was overridden by local environment files. Remove the Stripe overrides before running isolated billing tests.',
				)
			}
		}
		// Jobs + highlight stay attached in the test env (Playwright e2e).
		// Platform/runtime have no test env and stay skipped there. Pin the
		// registered names so origin `service: "kody-jobs"` / `kody-highlight`
		// resolve under `--env production` (otherwise wrangler registers
		// `kody-jobs-production`).
		const jobsDevConfigPath = await writeLocalAuxiliaryDevConfig({
			configPath: 'packages/jobs-worker/wrangler.jsonc',
			envName,
			mainWorkerDevName: `kody-${envName}`,
			generatedBasename,
		})
		const highlightDevConfigPath = await writeLocalAuxiliaryDevConfig({
			configPath: 'packages/highlight-worker/wrangler.jsonc',
			envName,
			mainWorkerDevName: `kody-${envName}`,
			generatedBasename,
		})
		auxiliaryWorkers.push(
			{
				configPath: jobsDevConfigPath,
				devOnly: true,
			},
			{
				configPath: highlightDevConfigPath,
				devOnly: true,
			},
		)
		if (envName !== 'test') {
			const runtimeDevConfigPath = await writeLocalSiblingDevConfig({
				configPath: 'packages/runtime-worker/wrangler.jsonc',
				envName,
				mainWorkerDevName: `kody-${envName}`,
				port: process.env.PORT,
				generatedBasename,
			})
			const platformDevConfigPath = await writeLocalSiblingDevConfig({
				configPath: 'packages/platform-worker/wrangler.jsonc',
				envName,
				mainWorkerDevName: `kody-${envName}`,
				port: process.env.PORT,
				generatedBasename,
				dropAlwaysRemoteBindings: ['ai', 'artifacts'],
			})
			auxiliaryWorkers.push(
				{ configPath: runtimeDevConfigPath, devOnly: true },
				{ configPath: platformDevConfigPath, devOnly: true },
			)
		}
	}

	return {
		base: releaseBase,
		publicDir: 'packages/worker/public',
		environments: {
			client: {
				// The late-injected Buffer polyfill is missed by the initial dependency scan.
				// Prebundle it so first use cannot reload a page with an unfinished form.
				optimizeDeps: { include: ['buffer'] },
			},
			ssr: {
				optimizeDeps: { noDiscovery: true, include: [] },
				resolve: { noExternal: ['@tanstack/redact'] },
			},
		},
		ssr: { noExternal: ['@tanstack/redact'] },
		build: {
			sourcemap: true,
			outDir: process.env.KODY_VITE_OUTDIR ?? 'dist',
		},
		plugins: [
			markdownAsText(),
			inlineCssText(),
			cloudflare({
				configPath: serveWranglerConfigPath,
				viteEnvironment: { name: 'ssr' },
				persistState: { path: persistPath },
				// E2E webServer sets KODY_E2E_WEB_SERVER=1 and uses its own
				// persist dir + port. Disabling the inspector avoids fighting
				// a healthy `dev:ensure` origin for the default inspector port
				// (Parent environment not initialized / #3731).
				inspectorPort: (() => {
					if (process.env.KODY_E2E_WEB_SERVER === '1') return false
					if (process.env.KODY_VITE_INSPECTOR_PORT === 'false') return false
					const raw = process.env.KODY_VITE_INSPECTOR_PORT?.trim()
					if (!raw) return undefined
					if (!/^\d+$/.test(raw)) return undefined
					const port = Number.parseInt(raw, 10)
					return Number.isFinite(port) ? port : undefined
				})(),
				remoteBindings: false,
				auxiliaryWorkers,
			}),
			workerWholeGraphReload(),
			redact(),
			tanstackStart({
				srcDirectory: 'packages/worker/start',
				serverFns: {
					base: releaseBase === '/' ? '/_serverFn' : `${releaseBase}_serverFn/`,
				},
				router: {
					basepath: '/',
					codeSplittingOptions: {
						defaultBehavior: [
							['loader'],
							['component'],
							['pendingComponent'],
							['errorComponent'],
							['notFoundComponent'],
						],
					},
				},
				server: { entry: 'server.ts' },
			}),
			react({
				include: /\/start\/.*\.[jt]sx?$/,
				jsxImportSource: '@emotion/react',
			}),
			startReleaseAssets(releaseBase),
		],
		resolve: {
			alias: [
				...redactServerAliases,
				{
					find: /^use-sync-external-store\/shim\/index\.js$/,
					replacement: '@tanstack/redact',
				},

				{
					find: /^#start\/server\/(.*)$/,
					replacement: path.resolve(root, 'packages/worker/start/server/$1.ts'),
				},
				alias('#app', path.resolve(root, 'packages/worker/src/app')),
				alias('#client', path.resolve(root, 'packages/worker/client')),
				alias('#universal', path.resolve(root, 'packages/worker/universal')),
				alias('#worker', path.resolve(root, 'packages/worker/src')),
				alias('#mcp', path.resolve(root, 'packages/worker/src/mcp')),
			],
		},
		oxc: {
			jsx: { runtime: 'automatic' as const, importSource: '@emotion/react' },
		},
	}
})
