import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { playwrightCacheRoot } from './control-kody/playwright-browsers.ts'
import {
	installPlaywrightBrowsersUnzip,
	isCloudAgentEnvironment,
	planPlaywrightBrowsersUnzipInstall,
	shouldInstallPlaywrightBrowsersWithUnzip,
} from './install-playwright-browsers-unzip.ts'

const fixtureBrowsersJson = JSON.stringify({
	browsers: [
		{
			name: 'chromium',
			revision: '1234',
			installByDefault: true,
			browserVersion: '151.0.7922.34',
		},
		{
			name: 'chromium-headless-shell',
			revision: '1234',
			installByDefault: true,
			browserVersion: '151.0.7922.34',
		},
	],
})

function expectedInstallSteps(input: {
	cacheRoot: string
	tmpDir: string
	dirName: string
	zipName: string
	executable: string
}) {
	const installDir = path.join(input.cacheRoot, input.dirName)
	const zipPath = path.join(input.tmpDir, `playwright-${input.dirName}.zip`)
	return [
		{
			file: 'mkdir',
			args: ['-p', installDir],
			label: `mkdir ${installDir}`,
		},
		{
			file: 'curl',
			args: [
				'-fsSL',
				'-o',
				zipPath,
				`https://cdn.playwright.dev/builds/cft/151.0.7922.34/linux64/${input.zipName}`,
			],
			label: `curl ${input.zipName}`,
		},
		{
			file: 'unzip',
			args: ['-q', '-o', zipPath, '-d', installDir],
			label: `unzip ${input.zipName}`,
		},
		{
			file: 'chmod',
			args: ['+x', path.join(installDir, input.executable)],
			label: `chmod +x ${input.executable}`,
		},
		{
			file: 'touch',
			args: [path.join(installDir, 'INSTALLATION_COMPLETE')],
			label: 'touch INSTALLATION_COMPLETE',
		},
		{
			file: 'rm',
			args: ['-f', zipPath],
			label: `rm ${input.zipName}`,
		},
	]
}

test('Cloud Agent Linux uses native unzip and plans curl plus unzip for the browsers.json revision', async () => {
	const gateCases: Array<
		[Parameters<typeof shouldInstallPlaywrightBrowsersWithUnzip>[0], boolean]
	> = [
		[{ platform: 'linux', githubActions: false, cloudAgent: true }, true],
		[{ platform: 'linux', githubActions: false, cloudAgent: false }, false],
		[{ platform: 'linux', githubActions: true, cloudAgent: true }, false],
		[{ platform: 'darwin', githubActions: false, cloudAgent: true }, false],
	]
	expect(
		gateCases.filter(
			([input, want]) =>
				shouldInstallPlaywrightBrowsersWithUnzip(input) !== want,
		),
	).toEqual([])

	const homeDir = await mkdtemp(path.join(tmpdir(), 'playwright-unzip-'))
	const tmpDir = path.join(homeDir, 'tmp')
	const browsersJsonPath = path.join(homeDir, 'browsers.json')
	const agentEnv = {
		homeDir,
		agentSocketPath: path.join(homeDir, 'missing.sock'),
	}
	expect(isCloudAgentEnvironment(agentEnv)).toBe(false)
	await mkdir(path.join(homeDir, '.cursor', 'agent-hooks'), { recursive: true })
	expect(isCloudAgentEnvironment(agentEnv)).toBe(true)
	const cacheRoot = playwrightCacheRoot(homeDir)
	const markInstalled = async (dirName: string) => {
		await mkdir(path.join(cacheRoot, dirName), { recursive: true })
		await writeFile(path.join(cacheRoot, dirName, 'INSTALLATION_COMPLETE'), '')
	}
	try {
		await writeFile(browsersJsonPath, fixtureBrowsersJson)
		await markInstalled('chromium-1208')

		const plan = planPlaywrightBrowsersUnzipInstall({
			homeDir,
			browsersJsonPath,
			tmpDir,
		})
		expect(plan.status).toBe('install')
		if (plan.status !== 'install') return
		expect(plan.detail).toContain('chromium-1234')
		expect(plan.detail).toContain('chromium_headless_shell-1234')
		expect(plan.commands).toEqual([
			...expectedInstallSteps({
				cacheRoot,
				tmpDir,
				dirName: 'chromium-1234',
				zipName: 'chrome-linux64.zip',
				executable: 'chrome-linux64/chrome',
			}),
			...expectedInstallSteps({
				cacheRoot,
				tmpDir,
				dirName: 'chromium_headless_shell-1234',
				zipName: 'chrome-headless-shell-linux64.zip',
				executable: 'chrome-headless-shell-linux64/chrome-headless-shell',
			}),
		])

		const ran: Array<string> = []
		const status = installPlaywrightBrowsersUnzip(
			{ homeDir, browsersJsonPath, tmpDir },
			(command) => {
				ran.push(`${command.file} ${command.args.join(' ')}`)
				return { status: 0 }
			},
		)
		expect(status).toBe(0)
		expect(ran[0]).toBe(`mkdir -p ${path.join(cacheRoot, 'chromium-1234')}`)
		expect(ran.at(-1)).toBe(
			`rm -f ${path.join(tmpDir, 'playwright-chromium_headless_shell-1234.zip')}`,
		)

		await markInstalled('chromium-1234')
		await markInstalled('chromium_headless_shell-1234')
		expect(
			planPlaywrightBrowsersUnzipInstall({
				homeDir,
				browsersJsonPath,
				tmpDir,
			}),
		).toEqual({
			status: 'already-installed',
			detail:
				'Playwright chromium-1234 and chromium_headless_shell-1234 INSTALLATION_COMPLETE',
		})
	} finally {
		await rm(homeDir, { recursive: true, force: true })
	}
})
