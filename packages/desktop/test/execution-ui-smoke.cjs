const assert = require('node:assert/strict')
const { build } = require('esbuild')
const { mkdirSync } = require('node:fs')
const { chromium, expect } = require('@playwright/test')
const { resolve } = require('node:path')

// Browser-level component test. Native actions and server functions are fixtures;
// controller and authenticated server mutation tests cover those boundaries.
async function smoke() {
	const root = resolve(__dirname, '../../..')
	mkdirSync(resolve(root, 'artifacts'), { recursive: true })
	const bundled = await build({
		stdin: {
			contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {DesktopExecutionProvider, DesktopMachinePanel} from './packages/worker/start/components/desktop-execution.tsx';
const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
window.refreshFixture = () => client.invalidateQueries();
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><DesktopExecutionProvider actorKey="jane" username="jane" orgSlug="jane" pathname="/@jane"><DesktopMachinePanel/></DesktopExecutionProvider></QueryClientProvider>);
`,
			resolveDir: root,
			loader: 'tsx',
		},
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		jsx: 'automatic',
		define: { 'process.env.NODE_ENV': '"production"' },
		plugins: [
			{
				name: 'machine-boundary-fixtures',
				setup(build) {
					build.onResolve(
						{ filter: /^@tanstack\/react-(start|router)$/ },
						(args) => ({ path: args.path, namespace: 'fixture' }),
					)
					build.onResolve({ filter: /^#start\/server\// }, (args) => ({
						path: args.path,
						namespace: 'fixture',
					}))
					build.onResolve({ filter: /onboarding-query\.ts$/ }, () => ({
						path: 'onboarding',
						namespace: 'fixture',
					}))
					build.onResolve({ filter: /^#universal\// }, (args) => ({
						path: resolve(
							root,
							'packages/worker/universal',
							args.path.slice('#universal/'.length),
						),
					}))
					build.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
						contents:
							args.path === '@tanstack/react-start'
								? 'export const useServerFn = fn => fn;'
								: args.path === '@tanstack/react-router'
									? 'export const useRouter = () => ({invalidate: async()=>{}});'
									: args.path === 'onboarding'
										? 'export const onboardingQuery = () => ({queryKey:["onboarding"],queryFn:async()=>({payload:{needsOnboarding:window.fixture.needsOnboarding}})});'
										: args.path.endsWith('experiment-opt-in')
											? 'export const setExperiment = async()=>{};'
											: 'export const loadExecutionContextsPage = async()=>({payload:window.fixture.setup}); export const putDesktopExecutionFirst = async(input)=>{window.fixture.puts.push(input.data); if(window.fixture.failChain){window.fixture.failChain=false;throw new Error("Your chain changed. Try again.")}};',
					}))
				},
			},
		],
	})
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage({
			viewport: { width: 1000, height: 800 },
		})
		const errors = []
		page.on('pageerror', (error) => errors.push(error.message))
		async function mount(native, needsOnboarding = false, full = false) {
			await page.goto('about:blank')
			await page.setContent('<div id="root"></div>')
			await page.evaluate(
				({ native, needsOnboarding, full }) => {
					const state = {
						name: 'my-mac',
						platform: 'darwin',
						supported: true,
						signedIn: true,
						busy: false,
						hasSetup: false,
						commandsEnabled: null,
						contextId: null,
						running: false,
						needsVerification: false,
						blocked: false,
						onboardingSeen: false,
						cliReady: false,
						error: null,
					}
					window.fixture = {
						needsOnboarding,
						state,
						puts: [],
						logins: 0,
						registers: 0,
						setup: {
							enabled: true,
							orgSlug: 'jane',
							personalOrg: true,
							contexts: [],
							chain: {
								entries: full
									? [
											{ kind: 'context', id: 'ec_one' },
											{ kind: 'context', id: 'ec_two' },
											{ kind: 'context', id: 'ec_three' },
											{ kind: 'cloud' },
										]
									: [{ kind: 'cloud' }],
								strict: false,
							},
						},
					}
					if (native)
						window.kodyDesktop = {
							execution: {
								getState: async () => ({ ...state }),
								commandsStatus: async () => {
									state.commandsEnabled ??= false
									return { ...state }
								},
								enableCommands: async () => {
									state.commandsEnabled = true
									return { ...state }
								},
								disableCommands: async () => {
									state.commandsEnabled = false
									return { ...state }
								},
								signIn: async () => {
									window.fixture.logins++
									state.cliReady = true
									return { ...state }
								},
								connect: async (name) => {
									if (!state.contextId) window.fixture.registers++
									Object.assign(state, {
										name,
										contextId: 'ec_mac',
										hasSetup: true,
										running: true,
									})
									return { ...state }
								},
								start: async () => {
									state.running = true
									return { ...state }
								},
								stop: async () => {
									state.running = false
									return { ...state }
								},
								dismissOnboarding: async () => {
									state.onboardingSeen = true
									return { ...state }
								},
								completeOnboarding: async () => {
									state.onboardingSeen = true
									return { ...state }
								},
								forgetSetup: async () => {
									Object.assign(state, {
										contextId: null,
										hasSetup: false,
										running: false,
										onboardingSeen: true,
										cliReady: false,
									})
									return { ...state }
								},
							},
						}
				},
				{ native, needsOnboarding, full },
			)
			await page.addScriptTag({ content: bundled.outputFiles[0].text })
		}
		await mount(false)
		await expect(
			page.getByRole('heading', { name: 'This machine', exact: true }),
		).toHaveCount(0)
		await mount(true, true)
		await expect(
			page.getByRole('button', { name: 'Set up this machine', exact: true }),
		).toBeVisible()
		await expect(page.getByRole('dialog')).not.toBeVisible()
		await page.evaluate(async () => {
			window.fixture.needsOnboarding = false
			await window.refreshFixture()
		})
		await expect(page.getByRole('dialog')).toBeVisible()
		await page.getByRole('button', { name: 'Not now', exact: true }).click()
		await expect(page.getByRole('dialog')).not.toBeVisible()
		await page.evaluate(() => window.refreshFixture())
		await expect(page.getByRole('dialog')).not.toBeVisible()
		await page
			.getByRole('button', { name: 'Set up this machine', exact: true })
			.click()
		await page
			.getByRole('button', { name: 'Continue in browser', exact: true })
			.click()
		await expect(page.getByLabel('Machine name')).toHaveValue('my-mac')
		await page.screenshot({
			path: resolve(root, 'artifacts/desktop-machine-wizard.png'),
		})
		await page
			.getByRole('button', { name: 'Enable this machine', exact: true })
			.click()
		await expect(
			page.getByRole('heading', { name: 'This machine is ready', exact: true }),
		).toBeVisible()
		assert.deepEqual(await page.evaluate(() => window.fixture.puts), [
			{ orgSlug: 'jane', username: 'jane', contextId: 'ec_mac' },
		])
		await page.getByRole('button', { name: 'Done', exact: true }).click()
		await page
			.getByRole('button', { name: 'Allow host commands', exact: true })
			.click()
		await page
			.getByRole('button', { name: 'Turn off host commands', exact: true })
			.click()
		await expect(
			page.getByRole('button', { name: 'Allow host commands', exact: true }),
		).toBeVisible()
		await page
			.getByRole('button', { name: 'Pause execution', exact: true })
			.click()
		await expect(
			page.getByRole('button', { name: 'Resume execution', exact: true }),
		).toBeVisible()
		await page
			.getByRole('button', { name: 'Forget desktop setup', exact: true })
			.click()
		await page.getByRole('button', { name: 'Cancel', exact: true }).click()
		assert.equal(await page.evaluate(() => window.fixture.state.hasSetup), true)
		await page
			.getByRole('button', { name: 'Forget desktop setup', exact: true })
			.click()
		await page
			.getByRole('dialog')
			.getByRole('button', { name: 'Forget desktop setup', exact: true })
			.click()
		await expect(
			page.getByRole('button', { name: 'Set up this machine', exact: true }),
		).toBeVisible()
		await mount(true, false, true)
		await page
			.getByRole('button', { name: 'Continue in browser', exact: true })
			.click()
		await expect(
			page.getByRole('button', { name: 'Enable this machine', exact: true }),
		).toBeDisabled()
		await page
			.getByLabel('Your chain is full. Replace an entry')
			.selectOption('ec_two')
		await page.evaluate(() => {
			window.fixture.failChain = true
		})
		await page
			.getByRole('button', { name: 'Enable this machine', exact: true })
			.click()
		await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
			'Your chain changed',
		)
		await page
			.getByLabel('Your chain is full. Replace an entry')
			.selectOption('ec_two')
		await page
			.getByRole('button', { name: 'Enable this machine', exact: true })
			.click()
		await expect(
			page.getByRole('heading', { name: 'This machine is ready', exact: true }),
		).toBeVisible()
		assert.equal(await page.evaluate(() => window.fixture.registers), 1)
		assert.equal(
			await page.evaluate(() => window.fixture.puts[0].replaceContextId),
			'ec_two',
		)
		await mount(true, false, true)
		await page
			.getByRole('button', { name: 'Continue in browser', exact: true })
			.click()
		await page
			.getByLabel('Your chain is full. Replace an entry')
			.selectOption('ec_two')
		await page.getByRole('button', { name: 'Not now', exact: true }).click()
		await page.evaluate(() => {
			window.fixture.setup.chain.entries = [{ kind: 'cloud' }]
		})
		await page
			.getByRole('button', { name: 'Set up this machine', exact: true })
			.click()
		await page
			.getByRole('button', { name: 'Continue in browser', exact: true })
			.click()
		await page
			.getByRole('button', { name: 'Enable this machine', exact: true })
			.click()
		await expect(
			page.getByRole('heading', { name: 'This machine is ready', exact: true }),
		).toBeVisible()
		assert.equal(
			await page.evaluate(() => 'replaceContextId' in window.fixture.puts[0]),
			false,
		)
		assert.deepEqual(errors, [])
		console.log(
			'Desktop UI: browser hidden, onboarding order, skip/reopen, setup, chain replacement/retry, pause, and forget passed.',
		)
	} finally {
		await browser.close()
	}
}
smoke().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
