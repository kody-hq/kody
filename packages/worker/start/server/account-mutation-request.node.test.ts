import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/mutation', {
		method: 'POST',
		headers: { cookie: 'session=original' },
	}),
	mutate: vi.fn(async () => ({ value: { ok: true }, status: 200 })),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse: (data: unknown) => unknown }
		const builder = {
			validator(next: typeof schema) {
				schema = next
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
vi.mock('../../src/app/handlers/account-jobs.ts', () => ({
	setAccountJobKillSwitch: state.mutate,
	runAccountJobNow: state.mutate,
}))
vi.mock('../../src/app/handlers/account-workflows.ts', () => ({
	cancelAccountWorkflowRun: state.mutate,
}))
vi.mock('../../src/app/handlers/account-secret-providers.ts', () => ({
	bindAccountSecretProvider: state.mutate,
	unbindAccountSecretProvider: state.mutate,
	grantAccountSecretProvider: state.mutate,
	revokeAccountSecretProvider: state.mutate,
}))
vi.mock('../../src/app/handlers/account-integrations.ts', () => ({
	rotateAccountOauthAppCredentials: state.mutate,
	disconnectAccountIntegration: state.mutate,
	deleteAccountOauthApp: state.mutate,
	setAccountIntegrationUsage: state.mutate,
	approveAccountIntegrationPackage: state.mutate,
}))
vi.mock('../../src/app/handlers/account-connections.ts', () => ({
	disconnectAccountProvider: state.mutate,
	syncAccountDiscordRole: state.mutate,
}))
vi.mock('../../src/app/handlers/account-mcp-servers.ts', () => ({
	addAccountMcpServer: state.mutate,
	reconnectAccountMcpServer: state.mutate,
	refreshAccountMcpServer: state.mutate,
	setAccountMcpServerEnabled: state.mutate,
	setAccountMcpServerUsage: state.mutate,
	deleteAccountMcpServer: state.mutate,
	setAccountMcpServerOAuthClient: state.mutate,
	removeAccountMcpServerOAuthClient: state.mutate,
}))
vi.mock('../../src/app/handlers/account-email-destinations.ts', () => ({
	addAccountEmailDestination: state.mutate,
	resendAccountEmailDestination: state.mutate,
	setDefaultAccountEmailDestination: state.mutate,
	removeAccountEmailDestination: state.mutate,
}))
vi.mock('@tanstack/react-start/server', () => ({ setResponseHeader: vi.fn() }))
vi.mock('../../src/app/operation-result.ts', () => ({
	requireOperationResult: (result: {
		value?: unknown
		data?: unknown
		status?: number
	}) => {
		if (typeof result.status === 'number' && result.status >= 400) {
			const data = result.data
			throw new Error(
				data &&
					typeof data === 'object' &&
					'error' in data &&
					typeof data.error === 'string'
					? data.error
					: 'Unable to complete operation.',
			)
		}
		return result.value ?? result.data
	},
	operationResult: <T>(data: T, init: number | ResponseInit = 200) => ({
		data,
		status: typeof init === 'number' ? init : (init.status ?? 200),
		headers: typeof init === 'number' ? undefined : init.headers,
	}),
}))
vi.mock('../../src/app/handlers/account-experiments.ts', () => ({
	saveExperimentsPreference: state.mutate,
}))
import {
	addMcpServer,
	setMcpServerUsage,
	setMcpServerOAuthClient,
	updateExperiments,
	bindSecretProvider,
} from './account-mutations.ts'

test('experiments preference rejects untyped input before the domain write', async () => {
	state.mutate.mockClear()
	expect(() =>
		updateExperiments({ data: { experimentsOptIn: 'true' } as never }),
	).toThrow()
	expect(state.mutate).not.toHaveBeenCalled()
	await updateExperiments({ data: { experimentsOptIn: false } })
	expect(state.mutate).toHaveBeenCalledWith(
		expect.objectContaining({
			experimentsOptIn: false,
			request: state.request,
		}),
	)
})

test('provider mutation validation rejects non-string configuration before domain work', () => {
	state.mutate.mockClear()
	expect(() =>
		bindSecretProvider({
			data: {
				provider: '1password',
				packageId: 'pkg',
				doorSecretName: 'TOKEN',
				config: { host: 42 },
			} as never,
		}),
	).toThrow()
	expect(state.mutate).not.toHaveBeenCalled()
})

test('MCP server operations carry typed fields without UI metadata and preserve callback origin request', async () => {
	state.mutate.mockClear()
	await addMcpServer({
		data: {
			orgSlug: 'acme',
			name: 'Tools',
			url: 'https://tools.test/mcp',
			bearerToken: 'secret',
		},
	})
	expect(state.mutate).toHaveBeenLastCalledWith(
		expect.objectContaining({
			request: state.request,
			name: 'Tools',
			url: 'https://tools.test/mcp',
			bearerToken: 'secret',
		}),
	)
	await setMcpServerUsage({
		data: {
			orgSlug: 'acme',
			id: 'server',
			usageMode: 'packages',
			allowedPackageIds: ['pkg'],
		},
	})
	expect(state.mutate).toHaveBeenLastCalledWith(
		expect.objectContaining({
			id: 'server',
			usageMode: 'packages',
			allowedPackageIds: ['pkg'],
		}),
	)
	await setMcpServerOAuthClient({
		data: {
			orgSlug: 'acme',
			id: 'server',
			clientId: 'client',
			clientSecret: 'secret',
		},
	})
	expect(state.mutate).toHaveBeenLastCalledWith(
		expect.objectContaining({
			request: state.request,
			id: 'server',
			clientId: 'client',
			clientSecret: 'secret',
		}),
	)
	expect(state.mutate).not.toHaveBeenCalledWith(
		expect.objectContaining({ body: expect.anything() }),
	)
})
