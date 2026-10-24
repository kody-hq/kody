import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { credentialClientToolNames } from '#worker/mcp/execute-modules/credential-client-source.ts'
import { PackageAppRuntimeBridge } from './package-app.ts'
import {
	mintPackageAppVisitTicket,
	resetPackageAppVisitNoncesForTests,
} from './package-app-visit-ticket.ts'

const seenBindings: Array<string> = []

vi.mock('#worker/mcp/credential-client-tools.ts', () => ({
	createCredentialClientKodyTools: (input: {
		options: { binding: string }
	}) => {
		seenBindings.push(input.options.binding)
		return {
			credentialClientOpen: async () => ({ ok: true, value: { handle: 'h' } }),
			credentialClientSign: async () => ({
				ok: true,
				value: { signature: 'sig' },
			}),
		}
	},
}))

test('credential client binding comes from the visit ticket so open and sign share it across RPC instances', async () => {
	resetPackageAppVisitNoncesForTests()
	seenBindings.length = 0
	const sharedBinding = 'run:shared-across-rpc-instances'
	const visitAudience = {
		host: 'https://example.com',
		packageId: 'package-1',
		kodyId: 'example',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
	}
	const minted = await mintPackageAppVisitTicket({
		env: {} as Pick<Env, 'SECRET_STORE_KEY'>,
		visitor: {
			userId: personIdFromStored('user-1'),
			username: 'user',
			role: 'owner',
		},
		owner: {
			userId: ownerIdFromStored('user-1'),
			orgSlug: 'user',
			email: 'user@example.com',
			displayName: 'User',
		},
		audience: visitAudience,
		credentialClientBinding: sharedBinding,
	})
	const props = {
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		orgSlug: 'user',
		visitor: { userId: 'user-1', username: 'user', role: 'owner' },
		email: 'user@example.com',
		displayName: 'User',
		packageId: 'package-1',
		kodyId: 'example',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		packageStorageGrantIds: ['package-1'],
		packageSecretRefKey: '',
		packageBindingToken: 'binding-token-for-test',
		gatewayProps: null,
		visitAudience,
	}
	const opener = new PackageAppRuntimeBridge(
		{
			props: { ...props, credentialClientBinding: 'run:stale-opener' },
			waitUntil() {},
		} as never,
		{} as Env,
	)
	const signer = new PackageAppRuntimeBridge(
		{
			props: { ...props, credentialClientBinding: 'run:stale-signer' },
			waitUntil() {},
		} as never,
		{} as Env,
	)
	await opener.credentialClientCall({
		name: credentialClientToolNames.open,
		args: { key: 'powersync-jwt' },
		visitTicket: minted.ticket,
	})
	await signer.credentialClientCall({
		name: credentialClientToolNames.sign,
		args: { handle: 'h-from-ticket', host: 'powersync.example', operation: {} },
		visitTicket: minted.ticket,
	})
	expect(seenBindings).toEqual([sharedBinding, sharedBinding])
})
