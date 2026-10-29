import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { PackageAppRuntimeBridge } from './package-app.ts'
import {
	PackageAppCapabilityNotDeclaredError,
	packageAppAuthorityFallbackKindOf,
} from './package-app-authority-fallback.ts'

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
