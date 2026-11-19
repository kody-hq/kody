import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { defaultCookieFile, readSessionFile } from './control-kody.ts'
import { playwrightCookiesFromHeader } from './control-kody/browse.ts'
import { createDefaultEnsureDevDeps, ensureDev } from './ensure-dev.ts'
import { isExecutedDirectly } from './node-runtime.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')
export const mockupsDir = path.join(repoRoot, 'packages/worker/start/mockups')
export const mockupOutputRoot = path.join(repoRoot, '.tmp/mockups')

const usage =
	'usage: npm run mockup -- <name|file.mockup.tsx> [--states a,b] [--only light-desktop,dark-mobile] [--signed-in] [--keep-focus]'

export const mockupVariants = [
	{
		id: 'light-desktop',
		colorScheme: 'light',
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		isMobile: false,
	},
	{
		id: 'dark-desktop',
		colorScheme: 'dark',
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		isMobile: false,
	},
	{
		id: 'light-mobile',
		colorScheme: 'light',
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
	},
	{
		id: 'dark-mobile',
		colorScheme: 'dark',
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
	},
] as const

type MockupVariant = (typeof mockupVariants)[number]

export type MockupArgs = {
	target: string
	states: Array<string> | null
	variants: Array<MockupVariant>
	signedIn: boolean
	keepFocus: boolean
}

function list(value: string) {
	return value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
}

export function parseMockupArgs(argv: ReadonlyArray<string>): MockupArgs {
	let target: string | undefined
	let states: Array<string> | null = null
	let only: Array<string> | null = null
	let signedIn = false
	let keepFocus = false
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!
		const value = () => {
			const next = argv[++index]
			if (!next || next.startsWith('--'))
				throw new Error(`${arg} needs a value`)
			return list(next)
		}
		if (arg === '--states') states = value()
		else if (arg === '--only') only = value()
		else if (arg === '--signed-in') signedIn = true
		else if (arg === '--keep-focus') keepFocus = true
		else if (arg.startsWith('--')) throw new Error(`Unknown flag ${arg}`)
		else if (target) throw new Error(`Unexpected argument ${arg}`)
		else target = arg
	}
	if (!target) throw new Error(usage)
	const ids = mockupVariants.map((variant) => variant.id as string)
	const unknown = only?.filter((id) => !ids.includes(id)) ?? []
	if (unknown.length) {
		throw new Error(
			`Unknown --only ${unknown.join(', ')}. Variants: ${ids.join(', ')}`,
		)
	}
	return {
		target,
		states,
		variants: mockupVariants.filter(
			(variant) => !only || only.includes(variant.id),
		),
		signedIn,
		keepFocus,
	}
}

/** Mockup name for the dev page. Files outside the mockups folder are copied into `local/`. */
export function resolveMockupTarget(target: string, cwd = process.cwd()) {
	let file: string
	if (target.endsWith('.tsx')) {
		file = path.resolve(cwd, target)
		if (!file.startsWith(mockupsDir + path.sep)) {
			const copy = path.join(mockupsDir, 'local', path.basename(file))
			if (!existsSync(file)) throw new Error(`No mockup file at ${file}`)
			mkdirSync(path.dirname(copy), { recursive: true })
			copyFileSync(file, copy)
			file = copy
		}
	} else {
		file = path.join(mockupsDir, `${target}.mockup.tsx`)
	}
	if (!existsSync(file)) throw new Error(`No mockup file at ${file}`)
	const name = path
		.relative(mockupsDir, file)
		.split(path.sep)
		.join('/')
		.replace(/\.mockup\.tsx$/, '')
	const shell =
		readFileSync(file, 'utf8').match(/\bshell:\s*['"](\w+)['"]/)?.[1] ?? 'bare'
	return { name, shell }
}

function sessionCookieHeader(origin: string) {
	const cookieHeader = readSessionFile(
		defaultCookieFile(),
		origin,
	)?.cookieHeader
	if (!cookieHeader) {
		throw new Error(
			`No local session for ${origin}. Run: npm run control-kody -- login`,
		)
	}
	return cookieHeader
}

async function personalOrgSlug(origin: string, cookieHeader: string) {
	const response = await fetch(`${origin}/session`, {
		headers: { cookie: cookieHeader },
	})
	const body = (await response.json().catch(() => null)) as {
		session?: {
			username?: string
			organizations?: Array<{ slug: string; personal?: boolean }>
		}
	} | null
	const slug =
		body?.session?.organizations?.find((org) => org.personal)?.slug ??
		body?.session?.username
	if (!slug) {
		throw new Error(
			'The local session expired. Run: npm run control-kody -- login',
		)
	}
	return slug
}

async function settle(page: Page, keepFocus: boolean) {
	await page.waitForSelector('[data-mockup-ready]', {
		state: 'attached',
		timeout: 60_000,
	})
	await page.evaluate(async () => {
		await document.fonts.ready
		await Promise.all(
			[...document.images]
				.filter((image) => !image.complete)
				.map(
					(image) =>
						new Promise((resolve) => {
							image.onload = image.onerror = resolve
						}),
				),
		)
		await new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(resolve)),
		)
		// Wait for finite animations only (spinners loop), capped at 2s.
		const finite = document
			.getAnimations()
			.filter(
				(animation) =>
					animation.effect?.getComputedTiming().endTime !== Infinity,
			)
		await Promise.race([
			Promise.all(
				finite.map((animation) => animation.finished.catch(() => {})),
			),
			new Promise((resolve) => setTimeout(resolve, 2000)),
		])
	})
	// Dialogs focus on open, which paints a keyboard ring a real click would not.
	if (!keepFocus) {
		await page.evaluate(() =>
			(document.activeElement as HTMLElement | null)?.blur(),
		)
	}
}

function escapeHtml(text: string) {
	return text.replace(
		/[&<>"]/g,
		(char) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
	)
}

type Shot = { state: string; variant: MockupVariant; file: string }

export function contactSheetHtml(input: {
	name: string
	shell: string
	states: ReadonlyArray<string>
	shots: ReadonlyArray<Shot & { dataUrl: string }>
}) {
	const rows = input.states
		.map((state) => {
			const cells = input.shots
				.filter((shot) => shot.state === state)
				.map(
					(shot) =>
						`<figure><figcaption>${escapeHtml(state)} · ${shot.variant.id.replace('-', ' ')}</figcaption><img src="${shot.dataUrl}" style="width:${shot.variant.isMobile ? 240 : 640}px"></figure>`,
				)
				.join('')
			return `<section><h2>${escapeHtml(state)}</h2><div class="row">${cells}</div></section>`
		})
		.join('')
	return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;background:#e9ebee;font:14px/1.4 system-ui,sans-serif;color:#1d2125}
h1{margin:0 0 4px;font-size:20px} p{margin:0 0 16px;color:#5b6470}
h2{margin:20px 0 8px;font-size:15px}
.row{display:flex;gap:16px;align-items:flex-start}
figure{margin:0;background:#fff;border-radius:8px;padding:8px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
figcaption{font-size:12px;color:#5b6470;margin-bottom:6px}
img{display:block;max-height:1400px;object-fit:cover;object-position:top;border:1px solid #d8dce1}
</style><h1>${escapeHtml(input.name)}</h1><p>${escapeHtml(input.shell)} shell</p>${rows}`
}

async function capture(
	browser: Browser,
	input: {
		url: string
		variant: MockupVariant
		cookieHeader: string | null
		origin: string
		errors: Array<string>
	},
) {
	const context = await browser.newContext({
		colorScheme: input.variant.colorScheme,
		viewport: input.variant.viewport,
		deviceScaleFactor: input.variant.deviceScaleFactor,
		isMobile: input.variant.isMobile,
		hasTouch: input.variant.isMobile,
		reducedMotion: 'reduce',
	})
	if (input.cookieHeader) {
		await context.addCookies(
			playwrightCookiesFromHeader(input.cookieHeader, input.origin),
		)
	}
	const page = await context.newPage()
	page.on('pageerror', (error) =>
		input.errors.push(`${input.variant.id}: ${error.message}`),
	)
	await page.goto(input.url, { waitUntil: 'domcontentloaded' })
	return { context, page }
}

export async function renderMockup(args: MockupArgs) {
	const { name, shell } = resolveMockupTarget(args.target)
	const { origin } = await ensureDev(createDefaultEnsureDevDeps())
	const cookieHeader =
		args.signedIn || shell === 'workspace' ? sessionCookieHeader(origin) : null
	const basePath =
		shell === 'workspace'
			? `/@${await personalOrgSlug(origin, cookieHeader!)}/-/dev-mockups/${name}`
			: `/dev/mockups/${name}`
	const errors: Array<string> = []
	const browser = await chromium.launch()
	try {
		const probe = await capture(browser, {
			url: `${origin}${basePath}`,
			variant: mockupVariants[0],
			cookieHeader,
			origin,
			errors,
		})
		await probe.page.waitForSelector('[data-mockup-ready]', {
			state: 'attached',
			timeout: 120_000,
		})
		const statesAttr = await probe.page.getAttribute(
			'[data-mockup-states]',
			'data-mockup-states',
		)
		if (!statesAttr) {
			const text = await probe.page.locator('pre').first().textContent()
			throw new Error(`Mockup failed to render: ${text || 'unknown error'}`)
		}
		await probe.context.close()
		const allStates = statesAttr.split(',')
		const states = args.states ?? allStates
		const unknown = states.filter((state) => !allStates.includes(state))
		if (unknown.length) {
			throw new Error(
				`Unknown state ${unknown.join(', ')}. States: ${allStates.join(', ')}`,
			)
		}

		const outDir = path.join(mockupOutputRoot, name.replaceAll('/', '__'))
		mkdirSync(outDir, { recursive: true })
		const shots = await Promise.all(
			states.flatMap((state) =>
				args.variants.map(async (variant): Promise<Shot> => {
					const search = new URL(`${origin}${basePath}`).searchParams
					search.set('state', state)
					const { context, page } = await capture(browser, {
						url: `${origin}${basePath}?${search}`,
						variant,
						cookieHeader,
						origin,
						errors,
					})
					await settle(page, args.keepFocus)
					const file = path.join(outDir, `${state}-${variant.id}.png`)
					await page.screenshot({
						path: file,
						fullPage: true,
						animations: 'disabled',
						caret: 'hide',
					})
					await context.close()
					return { state, variant, file }
				}),
			),
		)

		const sheetPage = await browser.newPage({
			viewport: { width: 1200, height: 800 },
		})
		await sheetPage.setContent(
			contactSheetHtml({
				name,
				shell,
				states,
				shots: shots.map((shot) => ({
					...shot,
					dataUrl: `data:image/png;base64,${readFileSync(shot.file).toString('base64')}`,
				})),
			}),
			{ waitUntil: 'load' },
		)
		const sheet = path.join(outDir, 'contact-sheet.png')
		await sheetPage.screenshot({ path: sheet, fullPage: true })
		if (errors.length) {
			console.warn(`page errors:\n  ${[...new Set(errors)].join('\n  ')}`)
		}
		console.log(`out: ${outDir}\nsheet: ${sheet}`)
		return { outDir, sheet, shots }
	} finally {
		await browser.close()
	}
}

if (isExecutedDirectly(import.meta.url)) {
	try {
		await renderMockup(parseMockupArgs(process.argv.slice(2)))
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	}
}
