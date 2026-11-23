/**
 * `kody app check`: start the package's `kody dev serve` preview, render it in
 * a cached Playwright Chromium at desktop and mobile sizes in light and dark,
 * run axe-core and Lighthouse against it, collect console errors from the
 * browser and the dev server, and write `app-check.md` plus `app-check.json`.
 *
 * Quality findings are reported as pass or fail in those files. The command
 * only fails for real problems: the preview or browser could not start.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { DevEvent } from '../dev/dev-events.js'
import { loadPackageManifest } from '../package-manifest.js'
import { StructuredCliError } from '../structured-error.js'
import type { KodyTarget } from '../target.js'
import {
	loadAppCheckTools,
	type AppCheckTools,
	type PlaywrightBrowser,
	type PlaywrightPage,
} from './browser-tools.js'
import {
	buildAppCheckReport,
	formatAppCheckMarkdown,
	lighthouseCategories,
	type AppCheckColorScheme,
	type AppCheckConsoleEntry,
	type AppCheckLighthouse,
	type AppCheckReport,
	type AppCheckScreenshot,
	type AppCheckVariantAxe,
	type AppCheckViewport,
	type AxeViolation,
	type LighthouseCategory,
} from './report.js'

type AppCheckIo = {
	stdout: (text: string) => void
	stderr: (text: string) => void
}

const viewports: Record<
	AppCheckViewport,
	{
		viewport: { width: number; height: number }
		deviceScaleFactor: number
		isMobile: boolean
		hasTouch: boolean
	}
> = {
	desktop: {
		viewport: { width: 1280, height: 800 },
		deviceScaleFactor: 1,
		isMobile: false,
		hasTouch: false,
	},
	mobile: {
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
	},
}

const colorSchemes: ReadonlyArray<AppCheckColorScheme> = ['light', 'dark']
const previewReadyTimeoutMs = 180_000
const pageTimeoutMs = 30_000

/** Default report directory, inside the package and ignored by git. */
export function defaultAppCheckOutputDir(packageRoot: string): string {
	return join(packageRoot, '.kody', 'app-check')
}

export async function runAppCheck(input: {
	/** Package directory (defaults to the current directory). */
	packageDir?: string
	outputDir?: string
	target: KodyTarget
	org?: string
	json?: boolean
	io: AppCheckIo
	env?: NodeJS.ProcessEnv
}): Promise<number> {
	const manifest = await loadPackageManifest(
		resolve(input.packageDir ?? process.cwd()),
	)
	if (!manifest.app) {
		throw new StructuredCliError({
			code: 'dev_surface_missing',
			message: `${manifest.name} has no kody.app.entry, so there is no app to check.`,
			where: manifest.root,
			fix: 'Set `"kody": { "app": { "entry": "./app/router.ts" } }` in package.json, then run `kody app check` again.',
		})
	}
	const outputDir = resolve(
		input.outputDir ?? defaultAppCheckOutputDir(manifest.root),
	)
	const status = (message: string) => input.io.stderr(`${message}\n`)
	const tools = await loadAppCheckTools({
		...(input.env ? { env: input.env } : {}),
		onStatus: status,
	})
	await mkdir(outputDir, { recursive: true })
	await writeFile(join(outputDir, '.gitignore'), '*\n')

	const consoleEntries: Array<AppCheckConsoleEntry> = []
	status(`kody app check: starting the kody dev preview for ${manifest.name}…`)
	const preview = await startDevPreview({
		packageRoot: manifest.root,
		target: input.target,
		...(input.org ? { org: input.org } : {}),
		...(input.env ? { env: input.env } : {}),
		onServerError: (message) =>
			consoleEntries.push({ source: 'server', message }),
	})
	let report: AppCheckReport
	try {
		status(`kody app check: rendering ${preview.url}…`)
		const browser = await launchBrowser(tools)
		let screenshots: Array<AppCheckScreenshot>
		let axe: Array<AppCheckVariantAxe>
		try {
			;({ screenshots, axe } = await renderVariants({
				browser,
				tools,
				url: preview.url,
				outputDir,
				consoleEntries,
			}))
		} finally {
			await browser.close().catch(() => {})
		}
		status('kody app check: running Lighthouse…')
		const lighthouse = await runLighthouse({ tools, url: preview.url })
		report = buildAppCheckReport({
			package: { name: manifest.name, root: manifest.root },
			url: preview.url,
			target: input.target,
			checkedAt: new Date().toISOString(),
			outputDir,
			screenshots,
			axe,
			lighthouse,
			consoleEntries,
		})
	} finally {
		await preview.close()
	}

	const markdownPath = join(outputDir, 'app-check.md')
	const jsonPath = join(outputDir, 'app-check.json')
	await writeFile(markdownPath, formatAppCheckMarkdown(report))
	await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
	if (input.json) {
		input.io.stdout(
			`${JSON.stringify({
				result: report.result,
				summary: report.summary,
				markdown: markdownPath,
				json: jsonPath,
			})}\n`,
		)
	} else {
		input.io.stdout(
			`${report.summary}\n\nReport: ${markdownPath}\nFull results: ${jsonPath}\n`,
		)
	}
	return 0
}

async function freePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address ? address.port : 0
			server.close(() => resolvePort(port))
		})
	})
}

/**
 * Run this same CLI's `kody dev serve` on a free port, so the check renders
 * exactly the preview `kody dev` serves. Its NDJSON events carry server-side
 * errors into the report.
 */
async function startDevPreview(input: {
	packageRoot: string
	target: KodyTarget
	org?: string
	env?: NodeJS.ProcessEnv
	onServerError: (message: string) => void
}): Promise<{ url: string; close: () => Promise<void> }> {
	const cliEntry = process.argv[1]
	if (!cliEntry) {
		throw new StructuredCliError({
			code: 'app_check_preview_failed',
			message:
				'Could not find the running kody CLI entry to start the preview.',
			fix: 'Run `kody app check` through the `kody` command.',
		})
	}
	const port = await freePort()
	const child = spawn(
		process.execPath,
		[
			...process.execArgv,
			cliEntry,
			'dev',
			'serve',
			'--json',
			'--no-live-reload',
			'--port',
			String(port),
			'--target',
			input.target,
			...(input.org ? ['--org', input.org] : []),
		],
		{
			cwd: input.packageRoot,
			env: input.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		},
	)
	let stderrTail = ''
	child.stderr?.on('data', (chunk: Buffer) => {
		stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-8_000)
	})
	const close = async () => {
		await stopChild(child)
	}
	const ready = new Promise<string>((resolveReady, reject) => {
		const timer = setTimeout(() => {
			reject(
				previewFailedError(
					`it was not ready after ${previewReadyTimeoutMs / 1000}s`,
					stderrTail,
				),
			)
		}, previewReadyTimeoutMs)
		child.once('error', (error) => {
			clearTimeout(timer)
			reject(previewFailedError(error.message, stderrTail))
		})
		child.once('exit', (code) => {
			clearTimeout(timer)
			reject(
				previewFailedError(`kody dev exited with code ${code}`, stderrTail),
			)
		})
		const lines = createInterface({ input: child.stdout! })
		lines.on('line', (line) => {
			let event: DevEvent | { type: 'ready'; url: string }
			try {
				event = JSON.parse(line) as typeof event
			} catch {
				return
			}
			if (event.type === 'ready') {
				clearTimeout(timer)
				resolveReady(event.url)
				return
			}
			const message = serverErrorMessage(event)
			if (message) input.onServerError(message)
		})
	})
	try {
		return { url: await ready, close }
	} catch (error) {
		await close()
		throw error
	}
}

function serverErrorMessage(event: DevEvent): string | null {
	switch (event.type) {
		case 'runtime_error':
			return event.request
				? `${event.message} (${event.request.method} ${event.request.path})`
				: event.message
		case 'build_error':
			return event.file
				? `Build error in ${event.file}${event.line !== null ? `:${event.line}` : ''}: ${event.message}`
				: `Build error: ${event.message}`
		case 'log':
			return event.level === 'error' ? event.message : null
		default:
			return null
	}
}

function previewFailedError(
	reason: string,
	stderr: string,
): StructuredCliError {
	const tail = stderr.trim().split('\n').slice(-5).join('\n')
	return new StructuredCliError({
		code: 'app_check_preview_failed',
		message: `The kody dev preview did not start (${reason}).${tail ? `\n${tail}` : ''}`,
		fix: 'Run `kody dev` in the package to see the full error, fix it, then run `kody app check` again.',
	})
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return
	const exited = new Promise<void>((resolveExit) =>
		child.once('exit', () => resolveExit()),
	)
	child.kill('SIGTERM')
	const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
	await exited
	clearTimeout(timer)
}

async function launchBrowser(tools: AppCheckTools): Promise<PlaywrightBrowser> {
	try {
		return await tools.chromium.launch({ headless: true, channel: 'chromium' })
	} catch (error) {
		throw new StructuredCliError({
			code: 'browser_launch_failed',
			message: `Could not launch Playwright Chromium (${error instanceof Error ? firstLine(error.message) : String(error)}).`,
			where: tools.chromium.executablePath(),
			fix: 'On Linux, install the browser system libraries with `npx playwright install-deps chromium`, then run `kody app check` again.',
		})
	}
}

function firstLine(text: string): string {
	return text.split('\n')[0]?.trim() ?? ''
}

async function renderVariants(input: {
	browser: PlaywrightBrowser
	tools: AppCheckTools
	url: string
	outputDir: string
	consoleEntries: Array<AppCheckConsoleEntry>
}): Promise<{
	screenshots: Array<AppCheckScreenshot>
	axe: Array<AppCheckVariantAxe>
}> {
	const screenshots: Array<AppCheckScreenshot> = []
	const axe: Array<AppCheckVariantAxe> = []
	for (const viewport of ['desktop', 'mobile'] as const) {
		for (const colorScheme of colorSchemes) {
			const context = await input.browser.newContext({
				...viewports[viewport],
				colorScheme,
			})
			try {
				const page = await context.newPage()
				page.on('console', (message: never) => {
					const msg = message as {
						type: () => string
						text: () => string
						location: () => { url?: string }
					}
					if (msg.type() !== 'error') return
					const url = msg.location().url
					input.consoleEntries.push({
						source: 'browser',
						message: msg.text(),
						viewport,
						colorScheme,
						...(url ? { url } : {}),
					})
				})
				page.on('pageerror', (error: never) => {
					const err = error as Error
					input.consoleEntries.push({
						source: 'page',
						message: err.message || String(err),
						viewport,
						colorScheme,
					})
				})
				const response = await page.goto(input.url, {
					waitUntil: 'load',
					timeout: pageTimeoutMs,
				})
				await page
					.waitForLoadState('networkidle', { timeout: 5_000 })
					.catch(() => {})
				const path = join(input.outputDir, `${viewport}-${colorScheme}.png`)
				await page.screenshot({ path, fullPage: true })
				screenshots.push({
					viewport,
					colorScheme,
					path,
					status: response ? response.status() : null,
				})
				axe.push({
					viewport,
					colorScheme,
					...(await runAxe(page, input.tools.axeSource)),
				})
			} finally {
				await context.close().catch(() => {})
			}
		}
	}
	return { screenshots, axe }
}

async function runAxe(
	page: PlaywrightPage,
	axeSource: string,
): Promise<{ violations: Array<AxeViolation>; error?: string }> {
	try {
		await page.addScriptTag({ content: axeSource })
		const violations = await page.evaluate(async () => {
			const axe = (
				globalThis as unknown as {
					axe: { run: () => Promise<{ violations: Array<AxeViolation> }> }
				}
			).axe
			const result = await axe.run()
			return result.violations.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				help: violation.help,
				helpUrl: violation.helpUrl,
				description: violation.description,
				nodes: violation.nodes.map((node) => ({
					target: node.target.map(String),
					html: node.html,
					failureSummary: node.failureSummary,
				})),
			}))
		})
		return { violations }
	} catch (error) {
		return {
			violations: [],
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

async function runLighthouse(input: {
	tools: AppCheckTools
	url: string
}): Promise<AppCheckLighthouse> {
	const empty = Object.fromEntries(
		lighthouseCategories.map((category) => [category, null]),
	) as Record<LighthouseCategory, number | null>
	let chrome: Awaited<ReturnType<AppCheckTools['launchChrome']>> | undefined
	try {
		chrome = await input.tools.launchChrome({
			chromePath: input.tools.chromium.executablePath(),
			chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
		})
		const result = await input.tools.lighthouse(input.url, {
			port: chrome.port,
			output: 'json',
			logLevel: 'error',
			onlyCategories: [...lighthouseCategories],
		})
		const lhr = result?.lhr
		if (!lhr) return { scores: empty, error: 'Lighthouse returned no result.' }
		const scores = { ...empty }
		for (const category of lighthouseCategories) {
			const score = lhr.categories[category]?.score
			scores[category] =
				typeof score === 'number' ? Math.round(score * 100) : null
		}
		return {
			scores,
			...(lhr.runtimeError?.message ? { error: lhr.runtimeError.message } : {}),
		}
	} catch (error) {
		return {
			scores: empty,
			error: error instanceof Error ? error.message : String(error),
		}
	} finally {
		await chrome?.kill()
	}
}
