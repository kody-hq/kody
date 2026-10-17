import { expect, test } from 'vitest'
import {
	type AccountIntegrationsLoaderData,
	type AccountIntegrationListItem,
} from '#universal/loader-data.ts'
import {
	projectIntegrationWrites,
	type IntegrationWrite,
} from './integration-mutation.ts'
const connection = (name: string): AccountIntegrationListItem => ({
	name,
	appSlug: 'mail',
	provider: 'mail',
	appLabel: null,
	accountLabel: null,
	tokenUrl: 'https://mail.test/token',
	clientId: 'client',
	createdAt: '',
	updatedAt: '',
})
const payload: AccountIntegrationsLoaderData = {
	ok: true,
	email: 'user@example.com',
	username: 'user',
	integrations: [connection('one'), connection('two')],
	apps: [
		{
			slug: 'mail',
			provider: 'mail',
			label: null,
			clientId: 'client',
			hasClientSecret: true,
			tokenUrl: 'https://mail.test/token',
			authorizeUrl: null,
			apiBaseUrl: null,
			flow: 'pkce',
			usePkce: true,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			connectionCount: 2,
			connections: [
				{ name: 'one', accountLabel: null },
				{ name: 'two', accountLabel: null },
			],
			createdAt: '',
			updatedAt: '',
		},
	],
}
const removal = (name: string): IntegrationWrite => ({
	actorKey: 'actor',
	orgSlug: 'org',
	write: async () => undefined,
	removeNames: [name],
})
test('pending removals project independently over newer server rows without rewriting the cache', () => {
	const newer = {
		...payload,
		integrations: [...payload.integrations, connection('new')],
	}
	const both = projectIntegrationWrites(newer, [removal('one'), removal('two')])
	expect(both.integrations.map((row) => row.name)).toEqual(['new'])
	expect(both.apps).toEqual([])
	const oneUndone = projectIntegrationWrites(newer, [removal('two')])
	expect(oneUndone.integrations.map((row) => row.name)).toEqual(['one', 'new'])
	expect(oneUndone.apps[0]?.connections.map((row) => row.name)).toEqual(['one'])
	expect(oneUndone.apps[0]?.connectionCount).toBe(1)
	expect(payload.apps[0]?.connectionCount).toBe(2)
	expect(payload.integrations.map((row) => row.name)).toEqual(['one', 'two'])
})
