import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { credentialClientToolNames } from '#worker/mcp/execute-modules/credential-client-source.ts'
import { PackageAppRuntimeBridge } from './package-app.ts'
import type * as PackageAppAuthority from './package-app-authority.ts'
import type * as PackageAppAuthorityFallback from './package-app-authority-fallback.ts'
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

vi.mock('./package-app-authority.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageAppAuthority>()
	return {
		...actual,
		loadPackageAppRunsAs: async () => ({
			status: 'unavailable',
			reason: 'not-set',
			message: actual.packageAppRunsAsUnavailableMessages['not-set'],
		}),
	}
})

vi.mock('./package-app-authority-fallback.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageAppAuthorityFallback>()),
	schedulePackageAppAuthorityFallback: () => {},
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
	for (const bridge of [opener, signer]) {
		vi.spyOn(
			bridge as unknown as {
				publishedCredentialSupplier: () => Promise<null>
			},
			'publishedCredentialSupplier',
		).mockResolvedValue(null)
	}
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

test('plain credential(key) on an executor need is refused before any credential client opens', async () => {
	seenBindings.length = 0
	const bridge = new PackageAppRuntimeBridge(
		{
			props: {
				baseUrl: 'https://example.com',
				userId: ownerIdFromStored('user-1'),
				orgSlug: 'user',
				visitor: { userId: 'user-1', username: 'user', role: 'owner' },
				packageId: 'package-1',
				kodyId: 'example',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				packageStorageGrantIds: ['package-1'],
				credentialClientBinding: 'run:test',
				packageSecretRefKey: '',
				packageBindingToken: 'binding-token-for-test',
				gatewayProps: null,
			},
			waitUntil() {},
		} as never,
		{} as Env,
	)
	vi.spyOn(
		bridge as unknown as {
			publishedCredentialSupplier: (key: string) => Promise<string | null>
		},
		'publishedCredentialSupplier',
	).mockImplementation(async (key) => (key === 'github' ? 'executor' : null))

	await expect(
		bridge.credentialClientCall({
			name: credentialClientToolNames.open,
			args: { key: 'github' },
		}),
	).rejects.toMatchObject({
		body: {
			code: 'credential_denied',
			message: expect.stringContaining('credential.visitor("github")'),
		},
	})
	expect(seenBindings).toEqual([])
})

test('an executor-only ticket answers identity only and acts as no visitor elsewhere', async () => {
	resetPackageAppVisitNoncesForTests()
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
			userId: personIdFromStored('outsider-1'),
			username: 'outsider',
			role: null,
		},
		owner: {
			userId: ownerIdFromStored('org-1'),
			orgSlug: 'org',
			email: '',
			displayName: 'Org',
		},
		audience: visitAudience,
		credentialClientBinding: 'run:outsider',
		grantId: 'grant-1',
		scopes: ['profile', 'need:github'],
		executorOnly: true,
	})
	const bridge = new PackageAppRuntimeBridge(
		{
			props: {
				baseUrl: 'https://example.com',
				userId: ownerIdFromStored('org-1'),
				orgSlug: 'org',
				visitor: null,
				packageId: 'package-1',
				kodyId: 'example',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				packageStorageGrantIds: ['package-1'],
				credentialClientBinding: 'run:outsider',
				packageSecretRefKey: '',
				packageBindingToken: 'binding-token-for-test',
				gatewayProps: null,
				visitAudience,
			},
			waitUntil() {},
		} as never,
		{} as Env,
	)
	const internals = bridge as unknown as {
		visitorFor: (ticket: string) => Promise<unknown>
		createCallerContext: (
			storageId: string | null,
			ticket: string,
		) => Promise<{ request: unknown; user: unknown }>
		visitorIdentityAnswer: (
			boundPackageId: string | null,
			args: Record<string, unknown>,
			ticket: string,
		) => Promise<unknown>
	}
	expect(await internals.visitorFor(minted.ticket)).toBeNull()
	const context = await internals.createCallerContext(null, minted.ticket)
	expect(context.user).toBeNull()
	expect(context.request).toBeNull()
	expect(
		await internals.visitorIdentityAnswer(null, {}, minted.ticket),
	).toEqual({
		user_id: 'outsider-1',
		username: 'outsider',
		email: '',
		display_name: 'outsider',
		org: { slug: 'org' },
		scopes: ['profile', 'need:github'],
	})
})
