import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { expect, test } from 'vitest'
import { createKodyRemoteProxy } from '#mcp/executor.ts'
import {
	createRuntimeModuleReexportSource,
	createRuntimeModuleSource,
} from './module-graph.ts'
import {
	createPackageRuntimeModuleSource,
	createPublicRuntimeModuleSource,
} from './runtime-source-modules.ts'

// The kody:runtime virtual module captures its named exports statically
// when it evaluates inside the surrounding AsyncLocalStorage context. The
// surrounding wrapper (kody executor / package-app worker) loads the
// bundle fresh per request, so each request gets a fresh evaluation with
// the per-request runtime values.
//
// These tests stand up the same shape against the local filesystem to verify
// that two concurrent calls each capture their own runtime view, optional
// runtime exports stay falsy so user code's `if (email) { ... }` guards keep
// working, and a preloaded runtime still late-binds the always-present kody
// namespace inside the execution context.

const runtimeSource = createRuntimeModuleSource()

type McpServers = Record<
	string,
	Record<string, (args: unknown) => Promise<unknown>>
>

type RuntimeModule = {
	__kodyRunInRuntime: <T>(
		value: unknown,
		callback: () => Promise<T>,
	) => Promise<T>
	__kodyMeterStaticPackageExport: <T>(packageId: string, exportValue: T) => T
	__kodyCreatePackageBoundFetch: (
		packageId: string,
	) => (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
	__kodyRunWithPackageBindings: <T>(
		bindings: Map<string, unknown>,
		callback: () => T,
	) => T
	__kodyCreatePackageBoundSecrets: (packageId: string) => {
		get: (alias: string) => Promise<string>
		has: (alias: string) => Promise<boolean>
	}
	kody:
		| { tool_call: (args: unknown) => Promise<unknown>; mcp: McpServers }
		| undefined
	codemode?: unknown
	capabilities?: unknown
	credential?:
		| (((key: string) => Promise<unknown>) & {
				named: (name: string) => Promise<unknown>
		  })
		| undefined
	credentials?: ((key: string) => Promise<unknown>) | undefined
	email: { getMessage: (id: string) => Promise<unknown> } | null
	packageContext: Record<string, unknown> | null
	packageSecrets: { get: (alias: string) => Promise<string> }
	default: {
		kody?: { tool_call: (args: unknown) => Promise<unknown> }
		codemode?: unknown
		capabilities?: unknown
	}
}

type GlobalSymbols = Record<symbol, unknown>

async function writeTempFiles(
	cleanupCallbacks: Array<() => Promise<void>>,
	files: Record<string, string>,
) {
	// Resolve macOS temp-directory symlinks so relative and direct imports share one module.
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), 'kody-runtime-isolation-')),
	)
	cleanupCallbacks.push(() => rm(dir, { recursive: true, force: true }))
	const urls: Record<string, string> = {}
	for (const [relativePath, source] of Object.entries(files)) {
		const filePath = join(dir, relativePath)
		await mkdir(dirname(filePath), { recursive: true })
		await writeFile(filePath, source, 'utf8')
		urls[relativePath] = pathToFileURL(filePath).href
	}
	return urls
}

async function withRuntimeIsolationCleanup(
	callback: (helpers: {
		writeRuntimeFile: () => Promise<string>
		writeTempFiles: (
			files: Record<string, string>,
		) => Promise<Record<string, string>>
		installSharedStorage: () => AsyncLocalStorage<unknown>
		loadPreloadedRuntime: () => Promise<{
			storage: AsyncLocalStorage<unknown>
			mod: RuntimeModule
			kodyMcp: () => McpServers
		}>
	}) => Promise<void>,
) {
	const globals = globalThis as unknown as GlobalSymbols
	delete globals[Symbol.for('kody.runtimeStorage')]
	delete globals[Symbol.for('kody.secretAuthorityStorage')]
	const cleanupCallbacks: Array<() => Promise<void>> = []
	const writeRuntimeFile = async () =>
		(
			await writeTempFiles(cleanupCallbacks, {
				'.__kody_virtual__/runtime.js': runtimeSource,
			})
		)['.__kody_virtual__/runtime.js'] ?? ''
	const installSharedStorage = () => {
		const storage = new AsyncLocalStorage<unknown>()
		globals[Symbol.for('kody.runtimeStorage')] = storage
		return storage
	}
	try {
		await callback({
			writeRuntimeFile,
			writeTempFiles: (files) => writeTempFiles(cleanupCallbacks, files),
			installSharedStorage,
			loadPreloadedRuntime: async () => {
				const storage = installSharedStorage()
				const mod = (await import(await writeRuntimeFile())) as RuntimeModule
				return { storage, mod, kodyMcp: () => mod.kody?.mcp ?? {} }
			},
		})
	} finally {
		while (cleanupCallbacks.length > 0) {
			await cleanupCallbacks.pop()?.()
		}
	}
}

test('two concurrent runs observe their own runtime values', async () => {
	await withRuntimeIsolationCleanup(
		async ({ writeRuntimeFile, installSharedStorage }) => {
			const sharedStorage = installSharedStorage()
			const observations = new Map<string, Record<string, string>>()

			async function performRun(userId: string) {
				// Each "request" has its own fresh runtime module, mirroring the
				// production behaviour where DynamicWorkerExecutor / APP_LOADER.load()
				// produce a fresh isolate per request. The module evaluates inside
				// the AsyncLocalStorage context and captures the per-request runtime.
				const runtime = {
					kody: {
						async tool_call() {
							return { ok: true, userId }
						},
					},
					email: {
						async getMessage(id: string) {
							return { id: `${userId}:${id}` }
						},
					},
					packageContext: { packageId: `pkg-${userId}` },
				}
				await sharedStorage.run(runtime, async () => {
					const url = await writeRuntimeFile()
					await new Promise<void>((resolve) => setImmediate(resolve))
					const mod = (await import(url)) as RuntimeModule
					await new Promise<void>((resolve) => setImmediate(resolve))
					if (!mod.kody) throw new Error('kody missing')
					if (!mod.email) throw new Error('email missing')
					const toolResult = (await mod.kody.tool_call({})) as {
						userId: string
					}
					const emailResult = (await mod.email.getMessage('m-1')) as {
						id: string
					}
					observations.set(userId, {
						userId,
						toolValue: toolResult.userId,
						emailValue: emailResult.id,
						packageId: String(mod.packageContext?.packageId ?? ''),
					})
				})
			}

			await Promise.all([performRun('user-aaa'), performRun('user-bbb')])

			for (const userId of ['user-aaa', 'user-bbb']) {
				expect(observations.get(userId)).toEqual({
					userId,
					toolValue: userId,
					emailValue: `${userId}:m-1`,
					packageId: `pkg-${userId}`,
				})
			}
		},
	)
})

test('optional runtime exports stay falsy when the wrapper omits them', async () => {
	await withRuntimeIsolationCleanup(
		async ({ writeRuntimeFile, installSharedStorage }) => {
			const { mod, observedPackageContext } = await installSharedStorage().run(
				// Intentionally omit `email`, `kody` from the runtime payload to
				// mirror an execute call that did not bind any of those helpers.
				{ packageContext: { packageId: 'pkg-1' } },
				async () => {
					const mod = (await import(await writeRuntimeFile())) as RuntimeModule
					return { mod, observedPackageContext: { ...mod.packageContext } }
				},
			)

			// Each missing export must be falsy so user code that does
			// `if (email) {...}` continues to skip the branch.
			expect(mod.email).toBeNull()
			expect(mod.kody).toBeUndefined()
			expect(mod.codemode).toBeUndefined()
			expect(mod.capabilities).toBeUndefined()
			// packageContext is late-bound; read it inside the store run.
			expect(observedPackageContext).toEqual({ packageId: 'pkg-1' })
		},
	)
})

// Package-app once imported runtime.js at entry load (before ALS.run). That
// froze credential as undefined forever — later createRuntime bindings never
// healed the export. Entry must defer first runtime evaluation until inside
// ALS (user import of kody:runtime), and read secret authority via Symbol.for.
test('credential freezes undefined when runtime.js first evaluates outside ALS', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, mod } = await loadPreloadedRuntime()
		expect(mod.credential).toBeUndefined()
		expect(mod.credentials).toBeUndefined()
		const credentialRuntime = {
			credential: Object.assign(
				async (key: string) => ({ key, sign: async () => 'sig' }),
				{ named: async (name: string) => ({ name }) },
			),
			credentials: async (key: string) => [{ key }],
		}
		await storage.run(credentialRuntime, async () => {
			expect(mod.credential).toBeUndefined()
			expect(mod.credentials).toBeUndefined()
		})
	})
})

test('credential is callable when runtime.js first evaluates inside ALS with binding', async () => {
	await withRuntimeIsolationCleanup(
		async ({ writeRuntimeFile, installSharedStorage }) => {
			const storage = installSharedStorage()
			const credentialRuntime = {
				credential: Object.assign(
					async (key: string) => ({
						key,
						sign: async () => `signed:${key}`,
					}),
					{ named: async (name: string) => ({ name }) },
				),
				credentials: async (key: string) => [{ key }],
			}
			const result = await storage.run(credentialRuntime, async () => {
				const mod = (await import(await writeRuntimeFile())) as RuntimeModule
				expect(typeof mod.credential).toBe('function')
				expect(typeof mod.credentials).toBe('function')
				if (!mod.credential) throw new Error('credential missing')
				const handle = (await mod.credential('powersync-jwt')) as {
					key: string
					sign: () => Promise<string>
				}
				return {
					key: handle.key,
					signature: await handle.sign(),
					named: await mod.credential.named('powersync-jwt'),
					list: await mod.credentials?.('powersync-jwt'),
				}
			})
			expect(result).toEqual({
				key: 'powersync-jwt',
				signature: 'signed:powersync-jwt',
				named: { name: 'powersync-jwt' },
				list: [{ key: 'powersync-jwt' }],
			})
		},
	)
})

function createCredentialRuntimeForFetchPathTest() {
	return {
		credential: Object.assign(
			async (key: string) => ({
				key,
				sign: async () => `signed:${key}`,
			}),
			{ named: async (name: string) => ({ name }) },
		),
		credentials: async (key: string) => [{ key }],
	}
}

const packageAppUserFetchSource = `
import { credential } from './.__kody_virtual__/runtime.js';
export default {
	async fetch() {
		if (typeof credential !== 'function') {
			throw new TypeError('credential is not a function');
		}
		const handle = await credential('powersync-jwt');
		const signature = await handle.sign();
		return { ok: true, key: handle.key, signature };
	},
};
`

// Mirrors PackageApp Entrypoint.fetch: createRuntime → ALS.run → import user →
// user.fetch. Entry load happens before ALS (Worker evaluates mainModule first).
async function runPackageAppFetchPath(input: {
	writeTempFiles: (
		files: Record<string, string>,
	) => Promise<Record<string, string>>
	installSharedStorage: () => AsyncLocalStorage<unknown>
	entrySource: string
}) {
	input.installSharedStorage()
	const urls = await input.writeTempFiles({
		'.__kody_virtual__/runtime.js': runtimeSource,
		'app.js': packageAppUserFetchSource,
		'package-app-entry.js': input.entrySource,
	})
	// Isolate loads mainModule before any request — same moment the old bug
	// statically imported runtime.js and froze credential.
	const entry = (await import(urls['package-app-entry.js'] ?? '')) as {
		simulateFetch: (runtime: unknown) => Promise<unknown>
	}
	return await entry.simulateFetch(createCredentialRuntimeForFetchPathTest())
}

test('hosted package-app fetch path: entry that pre-imports runtime freezes credential', async () => {
	await withRuntimeIsolationCleanup(
		async ({ writeTempFiles, installSharedStorage }) => {
			await expect(
				runPackageAppFetchPath({
					writeTempFiles,
					installSharedStorage,
					entrySource: `
import { __kodyGetSecretAuthority } from './.__kody_virtual__/runtime.js';
const storage = globalThis[Symbol.for('kody.runtimeStorage')];
export async function simulateFetch(runtime) {
	void __kodyGetSecretAuthority;
	return storage.run(runtime, async () => {
		const userModule = await import('./app.js');
		return await userModule.default.fetch();
	});
}
`,
				}),
			).rejects.toThrow(/credential is not a function/)
		},
	)
})

test('hosted package-app fetch path: deferred runtime import keeps credential callable', async () => {
	await withRuntimeIsolationCleanup(
		async ({ writeTempFiles, installSharedStorage }) => {
			const result = await runPackageAppFetchPath({
				writeTempFiles,
				installSharedStorage,
				entrySource: `
// Fixed package-app entry: no static import of runtime.js. Preload inside
// ALS before the user module so optional exports see the bound store and
// secret-authority stamps use the module export (not a forgeable Symbol).
const storage = globalThis[Symbol.for('kody.runtimeStorage')];
let getSecretAuthority = null;
async function ensureRuntimeLoaded() {
	if (typeof getSecretAuthority === 'function') return;
	const runtimeModule = await import('./.__kody_virtual__/runtime.js');
	getSecretAuthority = runtimeModule.__kodyGetSecretAuthority;
}
export async function simulateFetch(runtime) {
	return storage.run(runtime, async () => {
		await ensureRuntimeLoaded();
		const userModule = await import('./app.js');
		return await userModule.default.fetch();
	});
}
`,
			})
			expect(result).toEqual({
				ok: true,
				key: 'powersync-jwt',
				signature: 'signed:powersync-jwt',
			})
		},
	)
})

test('package code cannot reach the trusted package-binding scope (GHSA-5fv3)', () => {
	// The host wrapper enters the runtime's private binding scope; package
	// code only ever imports the public runtime or its own per-package facade,
	// neither of which re-exports the scope entry or any ambient getter.
	for (const source of [
		createPublicRuntimeModuleSource(),
		createPackageRuntimeModuleSource('pkg-a'),
	]) {
		expect(source).not.toContain('__kodyRunWithPackageBindings')
		expect(source).not.toContain('getSecretAuthority')
		expect(source).not.toMatch(/export \*/)
	}
	expect(runtimeSource).toContain(
		'export function __kodyRunWithPackageBindings(',
	)
	expect(runtimeSource).not.toContain('kody.getSecretAuthority')
	expect(runtimeSource).not.toContain('__kodyGetSecretAuthority')
})

test('preloaded kody exports resolve from the active runtime store', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, mod } = await loadPreloadedRuntime()
		expect(mod.codemode).toBeUndefined()
		expect(mod.capabilities).toBeUndefined()
		expect(mod.default.codemode).toBeUndefined()
		expect(mod.default.capabilities).toBeUndefined()

		const echoKody = {
			kody: {
				async tool_call(args: unknown) {
					return { ok: true, args }
				},
			},
		}
		await expect(
			storage.run(echoKody, async () => {
				if (!mod.kody) throw new Error('kody missing')
				return await mod.kody.tool_call({ value: 'active-store' })
			}),
		).resolves.toEqual({ ok: true, args: { value: 'active-store' } })
		await expect(
			storage.run(echoKody, async () => {
				if (!mod.default.kody) throw new Error('default kody missing')
				return await mod.default.kody.tool_call({
					value: 'default-active-store',
				})
			}),
		).resolves.toEqual({ ok: true, args: { value: 'default-active-store' } })

		for (const [packageContext, expected] of [
			[{ packageId: 'pkg-a' }, 'pkg-a'],
			[{ packageId: 'pkg-b' }, 'pkg-b'],
			[null, null],
		] as const) {
			expect(
				storage.run(
					{ packageContext },
					() => mod.packageContext?.packageId ?? null,
				),
			).toBe(expected)
		}

		const secretsRuntime = (prefix: string) => ({
			packageSecrets: {
				async get(alias: string) {
					return `${prefix}:${alias}`
				},
			},
		})
		expect(
			storage.run(secretsRuntime('a'), () => 'get' in mod.packageSecrets),
		).toBe(true)
		for (const prefix of ['a', 'b']) {
			await expect(
				storage.run(secretsRuntime(prefix), () =>
					mod.packageSecrets.get('token'),
				),
			).resolves.toBe(`${prefix}:token`)
		}
		expect(
			storage.run({ packageSecrets: null }, () => 'get' in mod.packageSecrets),
		).toBe(false)
	})
})

test('preloaded kody.mcp survives bundler-style destructuring of server names', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, kodyMcp } = await loadPreloadedRuntime()
		const result = await storage.run(
			{
				// Match the pre-fix sandbox shape: kody.mcp is a get-only proxy
				// with no has/ownKeys/getOwnPropertyDescriptor traps.
				kody: new Proxy(
					{},
					{
						get(_target, property) {
							if (property !== 'mcp') return undefined
							return new Proxy(
								{},
								{
									get(_mcpTarget, serverName) {
										if (serverName !== 'home') return undefined
										return {
											async sonos_list_players() {
												return { players: ['Kitchen'] }
											},
										}
									},
								},
							)
						},
					},
				),
			},
			async () => {
				const { home } = kodyMcp()
				return await home!.sonos_list_players!({})
			},
		)
		expect(result).toEqual({ players: ['Kitchen'] })
	})
})

test('bundler-style destructure of a missing kody.mcp server late-binds to the calling run', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, kodyMcp } = await loadPreloadedRuntime()
		const emptyMcp = new Proxy(
			{},
			{
				get() {
					return undefined
				},
				getOwnPropertyDescriptor() {
					return undefined
				},
			},
		)
		const captured = storage.run(
			{
				kody: new Proxy(
					{},
					{
						get: (_target, property) =>
							property === 'mcp' ? emptyMcp : undefined,
					},
				),
			},
			() => kodyMcp().home!,
		)

		const result = await storage.run(
			{
				kody: {
					mcp: {
						home: {
							async bond_shade_set_position(args: unknown) {
								return { ok: true, args }
							},
						},
					},
				},
			},
			async () =>
				await captured.bond_shade_set_position!({
					deviceId: '8b1242b1616ed0f7',
					position: 0,
				}),
		)
		expect(result).toEqual({
			ok: true,
			args: { deviceId: '8b1242b1616ed0f7', position: 0 },
		})
	})
})

test('destructured kody.mcp tools resolve against the calling run', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, kodyMcp } = await loadPreloadedRuntime()
		const homeRuntime = (run: string) => ({
			kody: {
				mcp: {
					home: {
						async sonos_list_players() {
							return { run }
						},
					},
				},
			},
		})
		const captured = storage.run(homeRuntime('first'), () => {
			const { home } = kodyMcp()
			const { sonos_list_players } = home!
			return { home: home!, sonos_list_players: sonos_list_players! }
		})

		const result = await storage.run(homeRuntime('second'), async () => ({
			viaHome: await captured.home.sonos_list_players!({}),
			viaTool: await captured.sonos_list_players({}),
		}))
		expect(result).toEqual({
			viaHome: { run: 'second' },
			viaTool: { run: 'second' },
		})
	})
})

test('kody.mcp tool calls stay callable when the current run throws on Get', async () => {
	await withRuntimeIsolationCleanup(async ({ loadPreloadedRuntime }) => {
		const { storage, kodyMcp } = await loadPreloadedRuntime()
		const oauthWaitingMessage =
			'The MCP server "home" is waiting for OAuth authorization. Complete the authorization from /account/mcp-servers. Check mcpServerList for connection status.'
		const authenticatingHomeRuntime = () => ({
			kody: {
				mcp: createKodyRemoteProxy({
					entries: [
						{
							name: 'home',
							status: {
								state: 'authenticating',
								connected: false,
								toolCount: 0,
								message:
									'The MCP server "home" is waiting for OAuth authorization. Complete the authorization from /account/mcp-servers.',
								unavailableMessage: oauthWaitingMessage,
							},
							capabilities: [],
						},
					],
					async callTool() {
						throw new Error('authenticating servers must not dispatch')
					},
				}),
			},
		})

		const captured = storage.run(authenticatingHomeRuntime(), () => {
			// createKodyRemoteProxy throws on Get; the isolate stand-in is
			// callable and rethrows that same message on the call, not as a
			// TypeError "is not a function".
			const mcp = kodyMcp()
			expect(Object.keys(mcp)).toEqual(['home'])
			expect(Object.keys(mcp.home!)).toEqual([])
			for (const tool of [
				'venstar_get_thermostat_info',
				'sonos_list_players',
			]) {
				expect(() => mcp.home![tool]!({})).toThrow(oauthWaitingMessage)
			}
			const { home } = mcp
			const { venstar_get_thermostat_info } = home!
			expect(typeof venstar_get_thermostat_info).toBe('function')
			expect(() => venstar_get_thermostat_info!({})).toThrow(
				oauthWaitingMessage,
			)
			return {
				home: home!,
				venstar_get_thermostat_info: venstar_get_thermostat_info!,
			}
		})

		const result = await storage.run(
			{
				kody: {
					mcp: {
						home: {
							async venstar_get_thermostat_info(args: unknown) {
								return { ok: true, args }
							},
						},
					},
				},
			},
			async () => ({
				serverNames: Object.keys(kodyMcp()),
				toolNames: Object.keys(kodyMcp().home!),
				viaHome: await captured.home.venstar_get_thermostat_info!({
					thermostat: 'office',
				}),
				viaTool: await captured.venstar_get_thermostat_info({
					thermostat: 'office',
				}),
			}),
		)
		expect(result).toEqual({
			serverNames: ['home'],
			toolNames: ['venstar_get_thermostat_info'],
			viaHome: { ok: true, args: { thermostat: 'office' } },
			viaTool: { ok: true, args: { thermostat: 'office' } },
		})
	})
})

test('trusted package bindings are shared across hydrated runtime.js copies and scoped to the wrapper run (GHSA-5fv3)', async () => {
	await withRuntimeIsolationCleanup(async ({ writeTempFiles }) => {
		const siblingPath =
			'.__kody_packages__/pkg/.__published_bundle__/2e/.__kody_virtual__/runtime.js'
		const urls = await writeTempFiles({
			'.__kody_virtual__/runtime.js': runtimeSource,
			[siblingPath]: createRuntimeModuleReexportSource(siblingPath),
		})
		// Unbound fetch falls back to the global fetch captured at module init.
		const originalFetch = globalThis.fetch
		const originalTrim = String.prototype.trim
		const globalCalls: Array<string> = []
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			globalCalls.push(String(input))
			return new Response('global')
		}) as typeof fetch
		try {
			// Same URLs the sibling re-export resolves, so both copies share one
			// evaluated root (fresh temp dir per test).
			const rootCopy = (await import(
				urls['.__kody_virtual__/runtime.js'] ?? ''
			)) as RuntimeModule
			const siblingCopy = (await import(
				urls[siblingPath] ?? ''
			)) as RuntimeModule
			expect(siblingCopy.__kodyRunWithPackageBindings).toBe(
				rootCopy.__kodyRunWithPackageBindings,
			)
			const boundCalls: Array<string> = []
			const binding = (id: string) =>
				Object.freeze({
					fetch: async (input: RequestInfo | URL) => {
						boundCalls.push(`${id} ${String(input)}`)
						return new Response(id)
					},
					kodyCall: async () => null,
					packageSecretGet: async (alias: string) => {
						boundCalls.push(`${id} get ${alias}`)
						return `ref-${id}`
					},
					packageSecretHas: async () => true,
				})
			const bindings = new Map([['pkg-a', binding('pkg-a')]])
			const fetchA = siblingCopy.__kodyCreatePackageBoundFetch('pkg-a')
			const fetchB = rootCopy.__kodyCreatePackageBoundFetch('pkg-b')
			const secretsA = siblingCopy.__kodyCreatePackageBoundSecrets('pkg-a')

			// Outside the wrapper scope nothing is bound, and a package that is
			// not the run's own fails instead of acting as the caller.
			await expect(fetchA('https://example.com/out')).rejects.toThrow(
				/fetch for package "pkg-a" has no package binding in this run/,
			)
			// A package code forgery of the legacy globals changes nothing.
			const globals = globalThis as unknown as GlobalSymbols
			globals[Symbol.for('kody.secretAuthorityStorage')] = {
				getStore: () => 'pkg-a',
				run: (_packageId: string, callback: () => unknown) => callback(),
			}
			globals[Symbol.for('kody.getSecretAuthority')] = () => 'pkg-a'

			await rootCopy.__kodyRunWithPackageBindings(bindings, async () => {
				expect(await (await fetchA('https://example.com/a')).text()).toBe(
					'pkg-a',
				)
				// B has no binding of its own and cannot name A's.
				await expect(fetchB('https://example.com/b')).rejects.toThrow(
					/fetch for package "pkg-b" has no package binding in this run/,
				)
				// Alias normalization uses the trim captured at module init.
				let trimCalls = 0
				String.prototype.trim = function () {
					trimCalls += 1
					return Reflect.apply(originalTrim, this, [])
				}
				try {
					expect(await secretsA.get('  wakeToken ')).toBe('ref-pkg-a')
				} finally {
					String.prototype.trim = originalTrim
				}
				expect(trimCalls).toBe(0)
			})
			// A callback that outlives the scope is unbound again.
			await expect(fetchA('https://example.com/after')).rejects.toThrow(
				/has no package binding in this run/,
			)
			expect(boundCalls).toEqual([
				'pkg-a https://example.com/a',
				'pkg-a get wakeToken',
			])
			// None of them reached the run's own fetch.
			expect(globalCalls).toEqual([])
			delete globals[Symbol.for('kody.getSecretAuthority')]
		} finally {
			globalThis.fetch = originalFetch
			String.prototype.trim = originalTrim
		}
	})
})

test('runtime evaluation installs no global secret-authority getter (GHSA-5fv3)', async () => {
	const authoritySymbol = Symbol.for('kody.getSecretAuthority')
	const globals = globalThis as unknown as GlobalSymbols
	const existing = Object.getOwnPropertyDescriptor(globalThis, authoritySymbol)
	if (!existing || existing.configurable) {
		Object.defineProperty(globalThis, authoritySymbol, {
			value: () => 'pkg-forged',
			configurable: true,
			writable: true,
			enumerable: false,
		})
	}
	try {
		await withRuntimeIsolationCleanup(async ({ writeRuntimeFile }) => {
			const before = Object.getOwnPropertyDescriptor(
				globalThis,
				authoritySymbol,
			)
			const mod = (await import(
				`${await writeRuntimeFile()}?t=${Date.now()}`
			)) as Record<string, unknown>
			// Identity no longer flows through this global; the runtime
			// neither reads nor (re)installs it.
			expect(
				Object.getOwnPropertyDescriptor(globalThis, authoritySymbol),
			).toEqual(before)
			expect(mod['__kodyGetSecretAuthority']).toBeUndefined()
		})
	} finally {
		const after = Object.getOwnPropertyDescriptor(globalThis, authoritySymbol)
		if (after?.configurable) delete globals[authoritySymbol]
	}
})

test('module secret-authority export ignores a sealed foreign global forge', async () => {
	const { Worker } = await import('node:worker_threads')
	const source = createRuntimeModuleSource()
	const result = await new Promise<{
		ok: boolean
		error: string
		globalValue: string | null
		moduleValue: string | null
	}>((resolve, reject) => {
		const worker = new Worker(
			`
import { parentPort } from 'node:worker_threads'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const authoritySymbol = Symbol.for('kody.getSecretAuthority')
Object.defineProperty(globalThis, authoritySymbol, {
	value: () => 'pkg-forged',
	configurable: false,
	writable: false,
	enumerable: false,
})
const filePath = join(tmpdir(), \`kody-sa-sealed-\${Date.now()}.mjs\`)
writeFileSync(filePath, ${JSON.stringify(source)})
try {
	const mod = await import(pathToFileURL(filePath).href)
	const globalValue =
		typeof globalThis[authoritySymbol] === 'function'
			? globalThis[authoritySymbol]()
			: null
	const moduleValue =
		typeof mod.__kodyGetSecretAuthority === 'function'
			? mod.__kodyGetSecretAuthority()
			: null
	parentPort.postMessage({
		ok: globalValue === 'pkg-forged' && moduleValue === null,
		error: '',
		globalValue,
		moduleValue,
	})
} catch (error) {
	parentPort.postMessage({
		ok: false,
		error: String(error),
		globalValue: null,
		moduleValue: null,
	})
} finally {
	try {
		rmSync(filePath, { force: true })
	} catch {
		// ignore cleanup failures in the worker
	}
}
`,
			{ eval: true },
		)
		worker.on('message', resolve)
		worker.on('error', reject)
		worker.on('exit', (code) => {
			if (code !== 0) {
				reject(
					new Error(`sealed-forge worker exited with code ${String(code)}`),
				)
			}
		})
	})
	expect(result.error).toBe('')
	expect(result.ok).toBe(true)
	expect(result.globalValue).toBe('pkg-forged')
	expect(result.moduleValue).toBeNull()
})
