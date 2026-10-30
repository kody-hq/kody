import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { PackageAppRuntimeBridge } from './package-app.ts'
import type * as PackageAppAuthority from './package-app-authority.ts'
import {
	PackageAppCapabilityNotDeclaredError,
	packageAppAuthorityFallbackKindOf,
} from './package-app-authority-fallback.ts'
import type * as PackageAppAuthorityFallback from './package-app-authority-fallback.ts'

const rejections = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('./package-app-authority.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthority>()),
	loadPackageAppRunsAs: async () => ({ status: 'ready' }),
}))

vi.mock('./package-app-authority-fallback.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthorityFallback>()),
	schedulePackageAppAuthorityFallback: () => {},
	schedulePackageAppAuthorityRejection: (input: {
		event: Record<string, unknown>
	}) => {
		rejections.push(input.event)
	},
}))

function bridgeWith(props: Record<string, unknown>) {
	const bridge = new PackageAppRuntimeBridge(
		{
			props: {
				baseUrl: 'https://example.com',
				userId: ownerIdFromStored('user-a'),
				orgSlug: 'user-a',
				visitor: null,
				packageId: 'app-package-id',
				kodyId: 'app',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				packageStorageGrantIds: ['app-package-id', 'helper-package-id'],
				credentialClientBinding: 'run:test',
				packageSecretRefKey: '',
				packageBindingToken: 'binding-token-for-test',
				gatewayProps: null,
				declaredCapabilities: [],
				visitorNeeds: {},
				...props,
			},
			waitUntil() {},
		} as never,
		{} as Env,
	)
	return bridge as unknown as {
		capabilityNotDeclared: (
			name: string,
			boundPackageId: string | null,
		) => PackageAppCapabilityNotDeclaredError
	}
}

/** A bridge whose legacy (visitor) attempt always fails, so runs-as errors surface. */
function dispatchBridge() {
	rejections.length = 0
	const bridge = new PackageAppRuntimeBridge(
		{
			props: {
				baseUrl: 'https://example.com',
				userId: ownerIdFromStored('user-a'),
				orgSlug: 'user-a',
				visitor: null,
				packageId: 'app-package-id',
				kodyId: 'app',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				packageStorageGrantIds: ['app-package-id', 'helper-package-id'],
				credentialClientBinding: 'run:test',
				packageSecretRefKey: '',
				packageBindingToken: 'binding-token-for-test',
				gatewayProps: null,
				declaredCapabilities: [],
				visitorNeeds: {},
				appPackage: { name: '@example/app', version: '1.2.0' },
				dependencyPackageNames: { 'helper-package-id': '@example/helper' },
			},
			waitUntil() {},
		} as never,
		{} as Env,
	)
	const internals = bridge as unknown as {
		createRunsAsCallerContext: () => unknown
		createCallerContext: () => Promise<unknown>
		invokeCapability: () => Promise<unknown>
		getCredentialClientTools: () => Promise<unknown>
	}
	vi.spyOn(internals, 'createRunsAsCallerContext').mockReturnValue({})
	vi.spyOn(internals, 'createCallerContext').mockResolvedValue({})
	vi.spyOn(internals, 'invokeCapability').mockRejectedValue(
		new Error('legacy refused'),
	)
	vi.spyOn(internals, 'getCredentialClientTools').mockRejectedValue(
		new Error('legacy refused'),
	)
	return bridge
}

async function rejectionFrom(call: Promise<unknown>) {
	const error = await call.then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(PackageAppCapabilityNotDeclaredError)
	return error as PackageAppCapabilityNotDeclaredError
}

test('names the checked app, the imported package that called, and the fix', () => {
	const error = new PackageAppCapabilityNotDeclaredError('secretSet', {
		app: { name: '@example/app', version: '1.2.0' },
		callingPackage: '@example/helper',
	})
	expect(error.capabilityName).toBe('secretSet')
	expect(error.message).toBe(
		'Package app capability "secretSet" is not listed in kody.app.capabilities of the app "@example/app@1.2.0". The call came from "@example/helper", a package the app imports. Apps run as their runs-as person (the publisher unless an Owner chose someone else) and may call only the Kody capabilities they declare, including calls made by packages they import. Fix: add "secretSet" to kody.app.capabilities in the package.json of "@example/app", then republish the app.',
	)
	expect(packageAppAuthorityFallbackKindOf(error)).toBe(
		'capability_not_declared',
	)
})

test('without context the message stays generic and still says how to fix it', () => {
	const error = new PackageAppCapabilityNotDeclaredError('secretList')
	expect(error.message).toBe(
		'Package app capability "secretList" is not listed in kody.app.capabilities. Apps run as their runs-as person (the publisher unless an Owner chose someone else) and may call only the Kody capabilities they declare, including calls made by packages they import. Fix: add "secretList" to kody.app.capabilities in the app\'s package.json, then republish the app.',
	)
	expect(packageAppAuthorityFallbackKindOf(error)).toBe(
		'capability_not_declared',
	)
})

test('credential.named points at kody.credentials instead of the capability list', () => {
	const error = new PackageAppCapabilityNotDeclaredError('credential.named', {
		app: { name: '@example/app', version: null },
	})
	expect(error.message).toContain(
		'Package app call "credential.named" cannot open the runs-as person\'s credentials by name in the app "@example/app".',
	)
	expect(error.message).not.toContain('is not listed in kody.app.capabilities')
	expect(error.message).toContain(
		'Fix: declare the credential as a need in kody.credentials in the package.json of "@example/app" and open it with credential(key), then republish the app.',
	)
})

test('the bridge names the imported package from bundle metadata, not the app itself', () => {
	const bridge = bridgeWith({
		appPackage: { name: '@example/app', version: '1.2.0' },
		dependencyPackageNames: { 'helper-package-id': '@example/helper' },
	})

	const fromHelper = bridge.capabilityNotDeclared(
		'secretSet',
		'helper-package-id',
	)
	expect(fromHelper).toBeInstanceOf(PackageAppCapabilityNotDeclaredError)
	expect(fromHelper.capabilityName).toBe('secretSet')
	expect(fromHelper.message).toContain('"@example/app@1.2.0"')
	expect(fromHelper.message).toContain(
		'The call came from "@example/helper", a package the app imports.',
	)
	expect(fromHelper.message).not.toContain('user-a')

	for (const bound of ['app-package-id', null]) {
		const fromApp = bridge.capabilityNotDeclared('secretSet', bound)
		expect(fromApp.message).toContain('"@example/app@1.2.0"')
		expect(fromApp.message).not.toContain('The call came from')
	}

	const unknown = bridge.capabilityNotDeclared('secretSet', 'other-id')
	expect(unknown.message).not.toContain('The call came from')
	expect(unknown.message).not.toContain('other-id')
})

test('a bridge built before app metadata existed still throws the generic error', () => {
	const error = bridgeWith({}).capabilityNotDeclared(
		'secretList',
		'helper-package-id',
	)
	expect(error.message).toContain(
		'is not listed in kody.app.capabilities. Apps run as their runs-as person',
	)
})

test('an imported package calling an undeclared capability through the binding is named in the error', async () => {
	const bridge = dispatchBridge()
	const error = await rejectionFrom(
		bridge.packageBoundCall({
			token: 'binding-token-for-test',
			packageId: 'helper-package-id',
			op: 'capability',
			name: 'secretSet',
			args: {},
		}),
	)
	expect(error.capabilityName).toBe('secretSet')
	expect(error.message).toContain('of the app "@example/app@1.2.0"')
	expect(error.message).toContain(
		'The call came from "@example/helper", a package the app imports.',
	)
	expect(rejections).toEqual([
		expect.objectContaining({
			packageId: 'app-package-id',
			callName: 'secretSet',
			kind: 'capability_not_declared',
		}),
	])
})

test('an imported package opening a credential by name through the binding is named in the error', async () => {
	const bridge = dispatchBridge()
	const error = await rejectionFrom(
		bridge.packageBoundCall({
			token: 'binding-token-for-test',
			packageId: 'helper-package-id',
			op: 'credentialClient',
			name: 'credentialClientOpen',
			args: { name: 'github' },
		}),
	)
	expect(error.capabilityName).toBe('credential.named')
	expect(error.message).toContain('in the app "@example/app@1.2.0"')
	expect(error.message).toContain(
		'The call came from "@example/helper", a package the app imports.',
	)
	expect(error.message).toContain(
		'Fix: declare the credential as a need in kody.credentials in the package.json of "@example/app"',
	)
	expect(rejections).toEqual([
		expect.objectContaining({
			callName: 'credential:credentialClientOpen',
			kind: 'capability_not_declared',
		}),
	])
})
