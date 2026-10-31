import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { PackageAppRuntimeBridge } from './package-app.ts'
import type * as PackageAppAuthority from './package-app-authority.ts'
import { PackageAppCapabilityNotDeclaredError } from './package-app-authority-rejections.ts'
import type * as PackageAppAuthorityRejections from './package-app-authority-rejections.ts'

const mcpTool = vi.hoisted(() => ({ calls: [] as Array<unknown> }))

vi.mock('./package-app-authority.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthority>()),
	loadPackageAppRunsAs: async () => ({ status: 'ready' }),
}))

vi.mock('./package-app-authority-rejections.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthorityRejections>()),
	schedulePackageAppAuthorityRejection: () => {},
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: async () => ({
		capabilityMap: {
			'mcp:home:court_get_status': {
				handler: async (args: unknown) => {
					mcpTool.calls.push(args)
					return { status: 'open' }
				},
			},
		},
	}),
}))

function bridgeDeclaring(declaredCapabilities: Array<string>) {
	mcpTool.calls.length = 0
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
				packageSecretRefKey: '',
				packageBindingToken: 'binding-token-for-test',
				gatewayProps: null,
				declaredCapabilities,
				visitorNeeds: {},
				appPackage: { name: '@example/app', version: '1.0.0' },
			},
			waitUntil() {},
		} as never,
		{} as Env,
	)
	const internals = bridge as unknown as {
		createRunsAsCallerContext: () => unknown
	}
	vi.spyOn(internals, 'createRunsAsCallerContext').mockReturnValue({})
	return bridge
}

test('a declared MCP tool runs through kody.mcp[server][tool]', async () => {
	const bridge = bridgeDeclaring(['mcp:home:court_get_status'])
	await expect(
		bridge.callCapability({
			name: 'mcp:home:court_get_status',
			args: { court: 1 },
		}),
	).resolves.toEqual({ status: 'open' })
	expect(mcpTool.calls).toEqual([{ court: 1 }])
})

test('an undeclared MCP tool is refused with the exact entry to add', async () => {
	const bridge = bridgeDeclaring(['mcp:home:court_get_status'])
	const error = await bridge
		.callCapability({ name: 'mcp:home:court_set_lights', args: {} })
		.then(
			() => null,
			(caught: unknown) => caught,
		)
	expect(error).toBeInstanceOf(PackageAppCapabilityNotDeclaredError)
	expect((error as Error).message).toContain(
		'Fix: add "mcp:home:court_set_lights" to kody.app.capabilities in the package.json of "@example/app"',
	)
	expect(mcpTool.calls).toEqual([])
})

test('another server with the same tool name is not covered', async () => {
	const bridge = bridgeDeclaring(['mcp:home:court_get_status'])
	await expect(
		bridge.callCapability({ name: 'mcp:office:court_get_status', args: {} }),
	).rejects.toBeInstanceOf(PackageAppCapabilityNotDeclaredError)
})
