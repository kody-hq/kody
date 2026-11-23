/**
 * The browser stack `kody app check` needs, installed into the Kody user cache
 * the first time the check runs and reused after that (the same on-demand
 * pattern as MSW for `--target mock`). Playwright drives the pages, axe-core
 * finds accessibility violations, and Lighthouse scores the page. None of them
 * are CLI install-time dependencies, and the types below are structural so the
 * published bundle never imports them.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureCachedNpmPackages } from '../cached-npm-install.js'
import { StructuredCliError } from '../structured-error.js'
import { userCacheDir } from '../workerd-binary.js'

/** Exact pins: bump deliberately and together. */
const appCheckDependencies = {
	'playwright-core': '1.63.0',
	lighthouse: '13.6.0',
	'axe-core': '4.14.0',
	'chrome-launcher': '1.2.3',
} as const

export type PlaywrightPage = {
	goto: (
		url: string,
		options: { waitUntil: 'load'; timeout: number },
	) => Promise<{ status: () => number } | null>
	waitForLoadState: (
		state: 'networkidle',
		options: { timeout: number },
	) => Promise<void>
	screenshot: (options: { path: string; fullPage: boolean }) => Promise<unknown>
	addScriptTag: (options: { content: string }) => Promise<unknown>
	evaluate: <T>(fn: () => Promise<T>) => Promise<T>
	on: (event: string, listener: (value: never) => void) => void
}

type PlaywrightContext = {
	newPage: () => Promise<PlaywrightPage>
	close: () => Promise<void>
}

export type PlaywrightBrowser = {
	newContext: (options: Record<string, unknown>) => Promise<PlaywrightContext>
	close: () => Promise<void>
}

export type AppCheckTools = {
	chromium: {
		launch: (options: Record<string, unknown>) => Promise<PlaywrightBrowser>
		executablePath: () => string
	}
	/** axe-core's browser source, injected into each page. */
	axeSource: string
	lighthouse: (
		url: string,
		flags: Record<string, unknown>,
	) => Promise<{ lhr: LighthouseResult } | undefined>
	launchChrome: (options: {
		chromePath: string
		chromeFlags: Array<string>
	}) => Promise<{ port: number; kill: () => void | Promise<void> }>
}

type LighthouseResult = {
	categories: Record<string, { score: number | null } | undefined>
	runtimeError?: { code?: string; message?: string }
}

function appCheckToolsRoot(cacheDir: string): string {
	const key = Object.entries(appCheckDependencies)
		.map(([name, version]) => `${name.replace('/', '+')}@${version}`)
		.join('_')
	return join(cacheDir, 'deps', 'app-check', key)
}

/**
 * Install the pinned packages and the Playwright Chromium build (first run
 * only), then import them from the cache.
 */
export async function loadAppCheckTools(input: {
	env?: NodeJS.ProcessEnv
	onStatus: (message: string) => void
}): Promise<AppCheckTools> {
	const env = input.env ?? process.env
	const root = appCheckToolsRoot(userCacheDir(env))
	try {
		await ensureCachedNpmPackages({
			root,
			dependencies: { ...appCheckDependencies },
			env,
			timeoutMs: 300_000,
			onInstall: () =>
				input.onStatus(
					'kody app check: installing Playwright, axe-core, and Lighthouse into the Kody cache (first run only)…',
				),
		})
	} catch (error) {
		throw toolsInstallFailedError({
			reason: error instanceof Error ? error.message : String(error),
			root,
		})
	}
	const require = createRequire(join(root, 'package.json'))
	const importFromCache = async (specifier: string) =>
		(await import(pathToFileURL(require.resolve(specifier)).href)) as Record<
			string,
			unknown
		>
	const playwright = await importFromCache('playwright-core')
	const chromium = (playwright.chromium ??
		(playwright.default as Record<string, unknown> | undefined)
			?.chromium) as AppCheckTools['chromium']
	await ensureChromium({ chromium, root, env, onStatus: input.onStatus })
	const axe = await importFromCache('axe-core')
	const axeSource = (axe.source ??
		(axe.default as { source?: string } | undefined)?.source) as string
	const lighthouse = (await importFromCache('lighthouse'))
		.default as AppCheckTools['lighthouse']
	const chromeLauncher = await importFromCache('chrome-launcher')
	const launch = (chromeLauncher.launch ??
		(chromeLauncher.default as Record<string, unknown> | undefined)
			?.launch) as AppCheckTools['launchChrome']
	return { chromium, axeSource, lighthouse, launchChrome: launch }
}

async function ensureChromium(input: {
	chromium: AppCheckTools['chromium']
	root: string
	env: NodeJS.ProcessEnv
	onStatus: (message: string) => void
}): Promise<void> {
	if (existsSync(input.chromium.executablePath())) return
	input.onStatus(
		'kody app check: downloading the Playwright Chromium browser (first run only)…',
	)
	const require = createRequire(join(input.root, 'package.json'))
	const cli = join(
		require.resolve('playwright-core/package.json'),
		'..',
		'cli.js',
	)
	const reason = await new Promise<string | null>((resolve) => {
		const child = spawn(
			process.execPath,
			[cli, 'install', 'chromium', '--no-shell'],
			{
				env: input.env,
				windowsHide: true,
				stdio: ['ignore', 'ignore', 'pipe'],
			},
		)
		let stderr = ''
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000)
		})
		const timer = setTimeout(() => {
			child.kill('SIGTERM')
			resolve('the download timed out after 600s')
		}, 600_000)
		child.on('error', (error) => {
			clearTimeout(timer)
			resolve(error.message)
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			resolve(
				code === 0
					? null
					: (stderr.trim().split('\n').at(-1) ??
							`playwright install exited ${code}`),
			)
		})
	})
	if (reason !== null || !existsSync(input.chromium.executablePath())) {
		throw new StructuredCliError({
			code: 'browser_download_failed',
			message: `Could not download the Playwright Chromium browser for kody app check (${reason ?? 'the browser executable is still missing'}).`,
			where: input.chromium.executablePath(),
			fix: 'Connect to the network and run `kody app check` again. Behind a proxy, set HTTPS_PROXY. To use a browser folder you already have, set PLAYWRIGHT_BROWSERS_PATH.',
		})
	}
}

function toolsInstallFailedError(input: {
	reason: string
	root: string
}): StructuredCliError {
	const specs = Object.entries(appCheckDependencies)
		.map(([name, version]) => `${name}@${version}`)
		.join(' ')
	return new StructuredCliError({
		code: 'app_check_tools_install_failed',
		message: `Could not install the kody app check tools (${input.reason}).`,
		where: input.root,
		fix:
			`Connect to the network and run \`kody app check\` again so the CLI can install ${specs} into the Kody cache. ` +
			'Offline? Set KODY_CACHE_DIR to a writable cache where those packages are already installed.',
		details: { packages: specs, cacheDir: input.root },
	})
}
