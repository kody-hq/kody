/**
 * `npm run ui:verify`: render the component gallery and key pages headlessly
 * in light and dark, desktop and mobile; run axe, a keyboard focus sweep, and
 * visual diffs against committed baselines. Writes screenshots and a report
 * under .tmp/ui-verify. See docs/contributing/ui-verify.md.
 *
 *   npm run ui:verify                 # verify
 *   npm run ui:verify -- --update     # accept current rendering as the baseline
 *   npm run ui:verify -- -g gallery   # only targets whose title matches
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { uiVerifyPaths } from '../e2e/ui-verify/paths.ts'
import {
	pinnedBrowserEndpointEnv,
	pinnedBrowserImage,
	pinnedBrowserRunArgs,
	visualChecksSkippedNote,
} from '../e2e/ui-verify/pinned-browser.ts'

const args = process.argv.slice(2)
const update = args.includes('--update')
const passthrough = args.filter((arg) => arg !== '--update')

function freePort() {
	return new Promise<number>((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			server.close(() =>
				typeof address === 'object' && address
					? resolve(address.port)
					: reject(new Error('no port')),
			)
		})
	})
}

function canConnect(port: number) {
	return new Promise<boolean>((resolve) => {
		const socket = connect(port, '127.0.0.1')
		socket.once('connect', () => {
			socket.end()
			resolve(true)
		})
		socket.once('error', () => resolve(false))
	})
}

async function startPinnedBrowser() {
	if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0)
		return null
	const pull = spawnSync('docker', ['pull', '--quiet', pinnedBrowserImage], {
		stdio: 'inherit',
	})
	if (pull.status !== 0) return null
	const port = await freePort()
	const name = `kody-ui-verify-${process.pid}`
	const run = spawnSync('docker', pinnedBrowserRunArgs({ name, port }), {
		stdio: ['ignore', 'ignore', 'inherit'],
	})
	if (run.status !== 0) return null
	const stop = () =>
		spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' })
	for (let attempt = 0; attempt < 240; attempt++) {
		if (await canConnect(port)) {
			// The port opens before run-server is accepting browsers.
			await delay(1000)
			return { endpoint: `ws://127.0.0.1:${port}/`, stop }
		}
		await delay(500)
	}
	spawnSync('docker', ['logs', name], { stdio: 'inherit' })
	stop()
	throw new Error(
		`${pinnedBrowserImage} run-server did not start within 2 minutes`,
	)
}

rmSync(uiVerifyPaths.output, { recursive: true, force: true })

for (const setup of [
	'tools/prepare-e2e-env.ts',
	'tools/ensure-playwright-browser.ts',
]) {
	const result = spawnSync('node', [setup], { stdio: 'inherit' })
	if (result.status !== 0) process.exit(result.status ?? 1)
}

const browser = await startPinnedBrowser()
if (!browser) {
	if (update || process.env.CI) {
		console.error(
			`ui:verify needs Docker to render baselines in ${pinnedBrowserImage}. Start Docker and rerun.`,
		)
		process.exit(1)
	}
	console.warn(`\n${visualChecksSkippedNote}\n`)
}

const run = spawnSync(
	'npx',
	[
		'playwright',
		'test',
		'--config',
		'playwright.ui-verify.config.ts',
		...(update ? ['--update-snapshots=changed'] : []),
		...passthrough,
	],
	{
		stdio: 'inherit',
		// npx is npx.cmd on Windows, which Node only spawns through a shell.
		shell: process.platform === 'win32',
		env: browser
			? { ...process.env, [pinnedBrowserEndpointEnv]: browser.endpoint }
			: process.env,
	},
)
browser?.stop()
if (run.status === 0 && update)
	console.log(
		`\nBaselines updated under ${uiVerifyPaths.baselines}/. Review them with git diff and commit them with the UI change.`,
	)
process.exit(run.status ?? 1)
