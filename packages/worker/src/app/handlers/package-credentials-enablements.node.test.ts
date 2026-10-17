import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	row: vi.fn(),
	resolve: vi.fn(),
	write: vi.fn(),
	disable: vi.fn(),
	enable: vi.fn(),
	plan: vi.fn(),
	apply: vi.fn(),
}))
vi.mock('#worker/enablements/repo.ts', () => ({ getEnablementById: state.row }))
vi.mock('#worker/enablements/service.ts', () => ({
	disableEnablementForCaller: state.disable,
	enableTriggerForCaller: state.enable,
	planTriggerEnablementForCaller: state.plan,
	runNewEnablementPlans: state.apply,
	TriggerEnablementError: class extends Error {
		code: string
		constructor(code: string, message: string) {
			super(message)
			this.code = code
		}
	},
}))
vi.mock('#worker/credentials/package-credential-mapping-changes.ts', () => ({
	resolveMappingChanges: state.resolve,
	writeMappingChanges: state.write,
	MappingWriteRefused: class extends Error {},
}))
vi.mock('#worker/credentials/package-credential-mappings.ts', () => ({
	loadPackageMappingScope: async (input: unknown) => input,
	buildPackageCredentialsView: async () => ({ ok: true }),
}))
import { mutatePackageCredentialMappings } from './package-credentials.ts'
const scope = {
	env: { APP_DB: {} },
	request: { actor: { userId: 'actor-a' } },
	savedPackage: { id: 'package-a', userId: 'org-a' },
	baseUrl: 'https://kody.test',
	canManage: false,
	triggers: [
		{ kind: 'cron', name: 'daily', instanceId: 'job-a', enablements: [] },
		{
			kind: 'subscription',
			name: 'email.message.received',
			instanceId: 'package-a',
			enablements: [],
		},
		{
			kind: 'webhook',
			name: 'notify',
			instanceId: 'webhook-a',
			enablements: [],
		},
	],
} as unknown as Parameters<typeof mutatePackageCredentialMappings>[0]['scope']
beforeEach(() => {
	vi.clearAllMocks()
	state.resolve.mockResolvedValue([])
	state.row.mockResolvedValue({
		packageId: 'package-a',
		enablerUserId: 'actor-a',
		triggerKind: 'cron',
		triggerName: 'daily',
		state: 'on',
	})
})

test('foreign actor, package or trigger ids are rejected before combined mapping writes', async () => {
	for (const row of [
		{ packageId: 'package-b' },
		{ enablerUserId: 'actor-b' },
		{ triggerName: 'different' },
	]) {
		state.row.mockResolvedValueOnce({
			packageId: 'package-a',
			enablerUserId: 'actor-a',
			triggerKind: 'cron',
			triggerName: 'daily',
			state: 'on',
			...row,
		})
		const result = await mutatePackageCredentialMappings({
			scope,
			body: {
				changes: [
					{
						target: { type: 'default', layer: 'mine' },
						needKey: 'github',
						credentials: [],
					},
				],
				enablements: [
					{
						trigger: { kind: 'cron', name: 'daily' },
						state: 'off',
						enablementId: 'foreign',
					},
				],
			},
		})
		expect(result.status).toBe(400)
		expect(state.write).not.toHaveBeenCalled()
		expect(state.disable).not.toHaveBeenCalled()
	}
})

test('the viewer can disable its scoped instance and explicitly add another without mapping writes', async () => {
	await mutatePackageCredentialMappings({
		scope,
		body: {
			enablements: [
				{
					trigger: { kind: 'cron', name: 'daily' },
					state: 'off',
					enablementId: 'mine',
				},
			],
		},
	})
	expect(state.disable).toHaveBeenCalledWith(
		expect.objectContaining({ request: scope.request, enablementId: 'mine' }),
	)
	state.plan.mockResolvedValue({ enablement: null, new: true })
	await mutatePackageCredentialMappings({
		scope,
		body: {
			enablements: [
				{
					trigger: { kind: 'cron', name: 'daily' },
					state: 'on',
					createInstance: true,
				},
			],
		},
	})
	expect(state.plan).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage: scope.savedPackage,
			request: scope.request,
			createInstance: true,
		}),
	)
	expect(state.apply).toHaveBeenCalledOnce()
	expect(state.write).not.toHaveBeenCalled()
})

test('invalid turn-on actions cannot commit a valid mapping change first', async () => {
	for (const action of [
		{ trigger: { kind: 'cron', name: 'undeclared' }, state: 'on' },
		{
			trigger: { kind: 'cron', name: 'undeclared' },
			state: 'on',
			createInstance: true,
		},
		{
			trigger: { kind: 'subscription', name: 'email.message.received' },
			state: 'on',
		},
		{
			trigger: { kind: 'subscription', name: 'email.message.received' },
			state: 'on',
			createInstance: true,
		},
		{ trigger: { kind: 'webhook', name: 'notify' }, state: 'on' },
		{
			trigger: { kind: 'webhook', name: 'notify' },
			state: 'on',
			createInstance: true,
		},
		{
			trigger: { kind: 'cron', name: 'daily' },
			state: 'on',
			createInstance: true,
			enablementId: 'existing',
		},
	]) {
		const result = await mutatePackageCredentialMappings({
			scope,
			body: {
				changes: [
					{
						target: { type: 'default', layer: 'mine' },
						needKey: 'github',
						credentials: [],
					},
				],
				enablements: [action],
			},
		})
		expect([400, 409]).toContain(result.status)
		expect(state.write).not.toHaveBeenCalled()
		expect(state.enable).not.toHaveBeenCalled()
		expect(state.plan).not.toHaveBeenCalled()
		expect(state.apply).not.toHaveBeenCalled()
	}
})

test('a named webhook enablement is validated against its endpoint sibling, not the first same-name URL', async () => {
	const ownRow = { id: 'enablement-b', enablerUserId: 'actor-a', state: 'on' }
	const multiScope = {
		...scope,
		triggers: [
			{
				kind: 'webhook',
				name: 'notify',
				instanceId: 'endpoint-a',
				enablements: [
					{ id: 'enablement-a', enablerUserId: 'actor-other', state: 'on' },
				],
			},
			{
				kind: 'webhook',
				name: 'notify',
				instanceId: 'endpoint-b',
				enablements: [ownRow],
			},
		],
	} as unknown as typeof scope
	state.row.mockResolvedValue({
		packageId: 'package-a',
		enablerUserId: 'actor-a',
		triggerKind: 'webhook',
		triggerName: 'notify',
		state: 'on',
	})
	const result = await mutatePackageCredentialMappings({
		scope: multiScope,
		body: {
			enablements: [
				{
					trigger: { kind: 'webhook', name: 'notify' },
					state: 'on',
					enablementId: 'enablement-b',
				},
			],
		},
	})
	expect(result.status).toBe(200)
	expect(state.enable).not.toHaveBeenCalled()
	expect(state.write).not.toHaveBeenCalled()
})
