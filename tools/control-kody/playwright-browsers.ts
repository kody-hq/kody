import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const playwrightInstallationComplete = 'INSTALLATION_COMPLETE'
const chromiumName = 'chromium'
const headlessShellName = 'chromium-headless-shell'

const linuxArchiveName = {
	[chromiumName]: 'chrome-linux64.zip',
	[headlessShellName]: 'chrome-headless-shell-linux64.zip',
} as const

type PlaywrightBrowserName = keyof typeof linuxArchiveName

export type PlaywrightBrowserCheck = {
	ok: boolean
	detail: string
}

export type PlaywrightBrowserRequirement = {
	revision: string
	browserVersion: string
	directory: string
	archiveName: string
	executableRelativePath: string
}

type ChromiumRequirements = {
	chromium: PlaywrightBrowserRequirement
	headlessShell: PlaywrightBrowserRequirement
}

const linuxExecutableRelativePath = {
	[chromiumName]: path.join('chrome-linux64', 'chrome'),
	[headlessShellName]: path.join(
		'chrome-headless-shell-linux64',
		'chrome-headless-shell',
	),
} as const

export function defaultPlaywrightBrowsersJsonPath(repoRoot: string) {
	return path.join(repoRoot, 'node_modules', 'playwright-core', 'browsers.json')
}

export function inspectPlaywrightBrowsers(input: {
	homeDir: string
	browsersJsonPath: string
}): PlaywrightBrowserCheck {
	const requirements = readChromiumRequirements(input.browsersJsonPath)
	if (!requirements.ok) return { ok: false, detail: requirements.detail }

	const cacheRoot = playwrightCacheRoot(input.homeDir)
	const missing = [requirements.chromium, requirements.headlessShell].filter(
		(browser) =>
			!existsSync(
				path.join(cacheRoot, browser.directory, playwrightInstallationComplete),
			),
	)
	if (missing.length > 0) {
		return {
			ok: false,
			detail: formatMissingPlaywrightBrowsers({
				cacheRoot,
				missing,
				chromium: requirements.chromium,
				headlessShell: requirements.headlessShell,
			}),
		}
	}

	return {
		ok: true,
		detail: `Playwright ${requirements.chromium.directory} and ${requirements.headlessShell.directory} ${playwrightInstallationComplete}`,
	}
}

export function playwrightCacheRoot(
	homeDir: string,
	platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
) {
	if (platform === 'darwin')
		return path.join(homeDir, 'Library', 'Caches', 'ms-playwright')
	if (platform === 'win32') {
		const localAppData =
			env.LOCALAPPDATA && (homeDir === env.USERPROFILE || homeDir === env.HOME)
				? env.LOCALAPPDATA
				: path.join(homeDir, 'AppData', 'Local')
		return path.join(localAppData, 'ms-playwright')
	}
	return path.join(homeDir, '.cache', 'ms-playwright')
}

export function playwrightLinuxArchiveUrl(
	browser: PlaywrightBrowserRequirement,
) {
	return `https://cdn.playwright.dev/builds/cft/${browser.browserVersion}/linux64/${browser.archiveName}`
}

function formatMissingPlaywrightBrowsers(input: {
	cacheRoot: string
	missing: ReadonlyArray<PlaywrightBrowserRequirement>
	chromium: PlaywrightBrowserRequirement
	headlessShell: PlaywrightBrowserRequirement
}) {
	const missingDirectories = input.missing
		.map((browser) => browser.directory)
		.join(', ')
	const downloads = [input.chromium, input.headlessShell]
		.map((browser) => playwrightLinuxArchiveUrl(browser))
		.join(' and ')
	const destinations = [input.chromium, input.headlessShell]
		.map((browser) => path.join(input.cacheRoot, browser.directory))
		.join(' and ')
	return `Playwright revision missing (${missingDirectories}). Required ${input.chromium.directory} and ${input.headlessShell.directory}. Do not run playwright install on this VM. Run npm run test:e2e:ensure (native unzip on Cloud Agent Linux) or unzip per docs/contributing/cloud-agents.md: curl ${downloads}, unzip into ${destinations}, chmod +x the chrome and chrome-headless-shell binaries, then touch ${playwrightInstallationComplete} in each directory.`
}

export function readChromiumRequirements(
	browsersJsonPath: string,
): ({ ok: true } & ChromiumRequirements) | { ok: false; detail: string } {
	let raw: string
	try {
		raw = readFileSync(browsersJsonPath, 'utf8')
	} catch {
		return {
			ok: false,
			detail: cannotVerify(`Cannot read ${browsersJsonPath}.`),
		}
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return {
			ok: false,
			detail: cannotVerify(
				`Cannot parse ${browsersJsonPath} as playwright-core browsers.json.`,
			),
		}
	}

	if (!isRecord(parsed) || !Array.isArray(parsed.browsers)) {
		return {
			ok: false,
			detail: cannotVerify(`${browsersJsonPath} has no browsers array.`),
		}
	}

	const chromium = readBrowser(parsed.browsers, chromiumName, browsersJsonPath)
	if (!chromium.ok) return chromium
	const headlessShell = readBrowser(
		parsed.browsers,
		headlessShellName,
		browsersJsonPath,
	)
	if (!headlessShell.ok) return headlessShell
	return {
		ok: true,
		chromium: chromium.browser,
		headlessShell: headlessShell.browser,
	}
}

function readBrowser(
	browsers: ReadonlyArray<unknown>,
	name: PlaywrightBrowserName,
	browsersJsonPath: string,
):
	| { ok: true; browser: PlaywrightBrowserRequirement }
	| { ok: false; detail: string } {
	for (const entry of browsers) {
		if (!isRecord(entry) || entry.name !== name) continue
		const revision = entry.revision
		const browserVersion = entry.browserVersion
		if (typeof revision !== 'string' || !/^[0-9]+$/.test(revision)) {
			return {
				ok: false,
				detail: cannotVerify(
					`${browsersJsonPath} ${name} revision must be digits.`,
				),
			}
		}
		if (
			typeof browserVersion !== 'string' ||
			!/^[0-9]+(?:\.[0-9]+)*$/.test(browserVersion)
		) {
			return {
				ok: false,
				detail: cannotVerify(
					`${browsersJsonPath} ${name} browserVersion must be a dotted version.`,
				),
			}
		}
		return {
			ok: true,
			browser: {
				revision,
				browserVersion,
				directory: `${name.replaceAll('-', '_')}-${revision}`,
				archiveName: linuxArchiveName[name],
				executableRelativePath: linuxExecutableRelativePath[name],
			},
		}
	}
	return {
		ok: false,
		detail: cannotVerify(`${browsersJsonPath} has no ${name} entry.`),
	}
}

function cannotVerify(lead: string) {
	return `${lead} Doctor cannot verify the Playwright browser revision.`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
