import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const mocks = vi.hoisted(() => ({
	user: { mcpUser: { userId: 'person-1' } } as unknown,
	scope: { baseUrl: 'https://kody.test' } as unknown,
	resolved: [] as Array<Record<string, unknown>>,
	write: vi.fn(async () => {}),
	loadScope: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: async () => mocks.user,
}))

vi.mock('#app/package-credentials-access.ts', () => ({
	loadPackageMappingScopeForViewer: mocks.loadScope,
}))

vi.mock('#worker/credentials/package-credential-mappings.ts', () => ({
	buildPackageCredentialsView: async () => ({ ok: true, view: 'fresh' }),
	loadPackageMappingScope: async () => mocks.scope,
}))

vi.mock(
	'#worker/credentials/package-credential-mapping-changes.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		resolveMappingChanges: async () => mocks.resolved,
		writeMappingChanges: mocks.write,
	}),
)

const { mutatePackageCredentialMappings } =
	await import('./package-credentials.ts')
const { MappingWriteRefused } =
	await import('#worker/credentials/package-credential-mapping-changes.ts')

const post = (body: unknown) =>
	mutatePackageCredentialMappings({ scope: mocks.scope as never, body })
const change = {
	target: { type: 'default', layer: 'mine' },
	needKey: 'mail',
	credentials: [{ name: 'resend-prod' }],
}

test('writes apply every change or none and return the fresh view', async () => {
	mocks.loadScope.mockResolvedValue(mocks.scope)
	const bad = await post({ changes: [{ ...change, needKey: '' }] })
	expect(bad.status).toBe(400)
	expect(bad.data).toMatchObject({ ok: false })
	expect((await post({ changes: [] })).status).toBe(400)

	mocks.resolved = [
		{ ...change, error: null },
		{
			...change,
			needKey: 'nope',
			error: { code: 'need_unknown', message: 'No need "nope".' },
		},
	]
	const refused = await post({
		changes: [change, { ...change, needKey: 'nope' }],
	})
	expect(refused.status).toBe(400)
	expect(refused.data).toEqual({
		ok: false,
		errors: [
			{
				needKey: 'nope',
				target: change.target,
				code: 'need_unknown',
				message: 'No need "nope".',
			},
		],
	})
	expect(mocks.write).not.toHaveBeenCalled()

	mocks.resolved = [{ ...change, error: null }]
	const saved = await post({ changes: [change] })
	expect(saved.status).toBe(200)
	expect(saved.data).toEqual({ ok: true, view: 'fresh' })
	expect(mocks.write).toHaveBeenCalledTimes(1)

	mocks.write.mockRejectedValueOnce(
		new McpCallerError('Webhook "incoming" is already on for another person.'),
	)
	expect((await post({ changes: [change] })).status).toBe(409)

	const resolvedChange = { ...change, error: null } as never
	mocks.write.mockRejectedValueOnce(
		new MappingWriteRefused(
			resolvedChange,
			'webhook_other_enabler',
			'Webhook "incoming" is already on for another person.',
		),
	)
	expect((await post({ changes: [change] })).status).toBe(409)

	mocks.write.mockRejectedValueOnce(
		new MappingWriteRefused(
			resolvedChange,
			'trigger_unknown',
			'No cron "daily".',
		),
	)
	const gone = await post({ changes: [change] })
	expect(gone.status).toBe(400)
	expect(gone.data).toEqual({
		ok: false,
		errors: [
			{
				needKey: 'mail',
				target: change.target,
				code: 'trigger_unknown',
				message: 'No cron "daily".',
			},
		],
	})
})
