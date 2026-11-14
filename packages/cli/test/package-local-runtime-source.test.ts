import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as esbuild from 'esbuild'
import {
	createPackageAppEntrySource,
	createPackageLocalRuntimeModuleSource,
} from '../src/package-local-runtime-source.js'

const samplePackageContext = {
	packageId: 'local:demo',
	kodyId: 'demo',
	sourceId: 'local:demo',
	publishedCommit: null,
	appBasePath: '',
	hostedUrl: 'http://127.0.0.1:0',
	assetBasePath: '/_assets',
	clientModuleUrl: null,
	cookiePrefix: '__kapp_0123456789ab_',
}

test('the kody dev app entry is valid ESM', async () => {
	const source = createPackageAppEntrySource({ sideEffectModules: [] })
	await esbuild.transform(source, { loader: 'js', format: 'esm' })
})

test('package-local runtime CAF includes packageId when packageBinding is set', () => {
	const binding = 'kpb1.test-binding.sig'
	const source = createPackageLocalRuntimeModuleSource({
		packageContext: samplePackageContext,
		mockStorage: true,
		packageBinding: binding,
	})
	assert.match(source, /const __kodyPackageBinding = "kpb1\.test-binding\.sig"/)
	assert.match(
		source,
		/__kodyPackageBinding \? \{ packageId: __kodyPackageBinding \} : \{\}/,
	)
	assert.match(source, /authenticatedFetch/)
	assert.match(source, /oauthClientCredentials/)
})

test('package-local runtime CAF omits packageId when packageBinding is absent', () => {
	const source = createPackageLocalRuntimeModuleSource({
		packageContext: samplePackageContext,
		mockStorage: true,
	})
	assert.match(source, /const __kodyPackageBinding = null/)
	assert.doesNotMatch(source, /kpb1\./)
})

test('package-local runtime rejects bare package UUIDs as packageBinding', () => {
	const source = createPackageLocalRuntimeModuleSource({
		packageContext: samplePackageContext,
		mockStorage: true,
		packageBinding: '11111111-1111-1111-1111-111111111111',
	})
	assert.match(source, /const __kodyPackageBinding = null/)
	assert.doesNotMatch(
		source,
		/const __kodyPackageBinding = "11111111-1111-1111-1111-111111111111"/,
	)
})

async function importRuntime(packageBinding?: string) {
	const source = createPackageLocalRuntimeModuleSource({
		packageContext: samplePackageContext,
		mockStorage: true,
		...(packageBinding ? { packageBinding } : {}),
	})
	const runtime = (await import(
		`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
	)) as {
		kody: Record<string, any>
		__kodyInstallLocalBridge: (bridge: unknown) => void
	}
	const calls: Array<{ path: Array<string>; args: Array<unknown> }> = []
	runtime.__kodyInstallLocalBridge({
		call: async (path: Array<string>, args: Array<unknown>) => {
			calls.push({ path, args })
			return null
		},
		gatewayFetch: null,
	})
	return { kody: runtime.kody, calls }
}

test('package-local kody.mcp calls send the signed package binding', async () => {
	const { kody, calls } = await importRuntime('kpb1.test-binding.sig')
	await kody.mcp.home.lights_on({ room: 'office' })
	await kody.mcp['home'].lights_on(
		{ room: 'den' },
		{ packageBinding: 'kpb1.forged' },
	)
	await kody.emailSend({ to: 'a@example.com' })
	assert.deepEqual(calls, [
		{
			path: ['kody', 'mcp', 'home', 'lights_on'],
			args: [{ room: 'office' }, { packageBinding: 'kpb1.test-binding.sig' }],
		},
		{
			path: ['kody', 'mcp', 'home', 'lights_on'],
			args: [{ room: 'den' }, { packageBinding: 'kpb1.test-binding.sig' }],
		},
		{ path: ['kody', 'emailSend'], args: [{ to: 'a@example.com' }] },
	])
})

test('package-local kody.mcp calls without a binding are unchanged', async () => {
	const { kody, calls } = await importRuntime()
	await kody.mcp.home.lights_on({ room: 'office' })
	assert.deepEqual(calls, [
		{ path: ['kody', 'mcp', 'home', 'lights_on'], args: [{ room: 'office' }] },
	])
})

async function importPackageRuntime(mockStorage: boolean) {
	const source = createPackageLocalRuntimeModuleSource({
		packageContext: samplePackageContext,
		mockStorage,
	})
	return (await import(
		`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
	)) as {
		packageStorage: () => { get?: (key: string) => Promise<unknown> }
		packageSecrets: {
			get: (alias: string) => Promise<unknown>
			has: (alias: string) => Promise<unknown>
		}
		email: unknown
		events: unknown
		packages: unknown
	}
}

function assertProdUnsupported(error: unknown, exportName: string) {
	assert.ok(error instanceof Error)
	assert.match(
		error.message,
		new RegExp(`${exportName} is intentionally unsupported on --target prod`),
	)
	assert.match(error.message, /--target mock/)
	assert.match(error.message, /publish and use packageAppFetch/)
	assert.match(
		error.message,
		/https:\/\/kody\.codes\/docs\/package-apps#won-t-do-storage-secrets-email-events-and-packages-on-target-prod/,
	)
}

test('--target prod refuses working-tree storage, secrets, email, events and packages', async () => {
	const mockRuntime = await importPackageRuntime(true)
	assert.equal(typeof mockRuntime.packageStorage().get, 'function')

	const runtime = await importPackageRuntime(false)
	assert.throws(
		() => runtime.packageStorage(),
		(error: unknown) => {
			assertProdUnsupported(error, 'packageStorage\\(\\)')
			return true
		},
	)
	await assert.rejects(runtime.packageSecrets.get('api'), (error: unknown) => {
		assertProdUnsupported(error, 'packageSecrets')
		return true
	})
	await assert.rejects(runtime.packageSecrets.has('api'), (error: unknown) => {
		assertProdUnsupported(error, 'packageSecrets')
		return true
	})
	assert.equal(runtime.email, null)
	assert.equal(runtime.events, null)
	assert.equal(runtime.packages, null)
})
