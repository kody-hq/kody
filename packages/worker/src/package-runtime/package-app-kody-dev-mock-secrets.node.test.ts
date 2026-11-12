import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	buildKodyDevMockSecret,
	PackageAppRuntimeBridge,
} from './package-app.ts'

type SecretBridge = {
	packageSecretGet: (input: { alias: string }) => Promise<{ value: string }>
	packageSecretHas: (input: { alias: string }) => Promise<{ has: boolean }>
	resolvePackageSecretMount: (...args: Array<unknown>) => Promise<unknown>
}

function bridgeWith(env: Partial<Env>) {
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
				packageStorageGrantIds: ['app-package-id'],
				credentialClientBinding: 'run:test',
				packageSecretRefKey: 'ref-key-for-test',
				packageBindingToken: 'binding-token-for-test',
				gatewayProps: null,
				declaredCapabilities: [],
				visitorNeeds: {},
			},
			waitUntil() {},
		} as never,
		env as Env,
	) as unknown as SecretBridge
	const resolveMount = vi
		.spyOn(bridge, 'resolvePackageSecretMount')
		.mockRejectedValue(new Error('the secret store must not be read'))
	return { bridge, resolveMount }
}

test('kody dev returns placeholders and never reads the secret store', async () => {
	const { bridge, resolveMount } = bridgeWith({ KODY_DEV_MOCK_SECRETS: 'true' })
	await expect(
		bridge.packageSecretGet({ alias: 'STRIPE_KEY' }),
	).resolves.toEqual({ value: buildKodyDevMockSecret('STRIPE_KEY') })
	await expect(
		bridge.packageSecretHas({ alias: 'STRIPE_KEY' }),
	).resolves.toEqual({ has: true })
	expect(resolveMount).not.toHaveBeenCalled()
	expect(buildKodyDevMockSecret(' STRIPE_KEY ')).toBe(
		'kody-dev-mock-secret:STRIPE_KEY',
	)
})

test('without the kody dev flag the real secret path runs', async () => {
	const { bridge, resolveMount } = bridgeWith({})
	await expect(
		bridge.packageSecretGet({ alias: 'STRIPE_KEY' }),
	).rejects.toThrow('the secret store must not be read')
	expect(resolveMount).toHaveBeenCalledTimes(1)
})

test('only the exact value true turns on kody dev placeholders', async () => {
	const { bridge, resolveMount } = bridgeWith({ KODY_DEV_MOCK_SECRETS: '1' })
	await expect(
		bridge.packageSecretGet({ alias: 'STRIPE_KEY' }),
	).rejects.toThrow()
	expect(resolveMount).toHaveBeenCalledTimes(1)
})
