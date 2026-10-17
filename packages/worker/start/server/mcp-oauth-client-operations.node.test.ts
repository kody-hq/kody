import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/client', {
		method: 'POST',
	}),
	create: vi.fn(async () => ({
		data: { ok: true, clients: [], createdClient: { clientSecret: 'once' } },
		status: 200,
	})),
	revoke: vi.fn(async () => ({ data: { ok: true, clients: [] }, status: 200 })),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse: (value: unknown) => unknown }
		const builder = {
			validator(value: typeof schema) {
				schema = value
				return builder
			},
			inputValidator(value: typeof schema) {
				schema = value
				return builder
			},
			handler(run: (input: { data: unknown }) => unknown) {
				return (input: { data: unknown }) =>
					run({ data: schema.parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: async (
		_options: unknown,
		run: (context: unknown) => unknown,
	) => run({ request: state.request, env: {}, user: {} }),
}))
vi.mock('../../src/app/handlers/account-mcp-oauth-clients.ts', () => ({
	createAccountMcpOauthClient: state.create,
	revokeAccountMcpOauthClient: state.revoke,
}))
vi.mock('../../src/app/operation-result.ts', () => ({
	requireOperationResult: (result: { data: unknown }) => result.data,
}))
import {
	createMcpOauthClient,
	revokeMcpOauthClient,
} from './account-mutations.ts'

test('create and revoke call separate operations with original audit request', async () => {
	const created = await createMcpOauthClient({
		data: { label: 'Client', redirectUris: 'https://client.test/callback' },
	})
	expect(state.create).toHaveBeenCalledWith(
		expect.objectContaining({
			request: state.request,
			label: 'Client',
			redirectUris: 'https://client.test/callback',
		}),
	)
	expect(created).toHaveProperty('createdClient.clientSecret', 'once')
	const revoked = await revokeMcpOauthClient({ data: { id: ' client-id ' } })
	expect(state.revoke).toHaveBeenCalledWith(
		expect.objectContaining({ request: state.request, id: 'client-id' }),
	)
	expect(revoked).not.toHaveProperty('createdClient')
})
