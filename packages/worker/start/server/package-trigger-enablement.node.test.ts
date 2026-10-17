import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	scope: vi.fn(),
	mutate: vi.fn(),
	authenticated: true,
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validator: { parse(data: unknown): unknown }
		const builder = {
			validator(value: typeof validator) {
				validator = value
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return async (input: { data: unknown }) =>
					run({ data: validator.parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: async (
		_options: unknown,
		run: (context: unknown) => Promise<unknown>,
	) => {
		if (!state.authenticated) throw new Error('Please sign in again.')
		return run({
			env: {},
			request: new Request('https://kody.test/_serverFn/write'),
			user: { id: 'actor' },
		})
	},
}))
vi.mock('../../src/app/package-credentials-access.ts', () => ({
	loadPackageMappingScopeForViewer: state.scope,
}))
vi.mock('../../src/app/handlers/package-credentials.ts', () => ({
	mutatePackageCredentialMappings: state.mutate,
}))
import { savePackageCredentialMappings } from './credential-approval-mutation.ts'
beforeEach(() => {
	state.authenticated = true
	state.scope
		.mockReset()
		.mockResolvedValue({ savedPackage: { id: 'original-package' } })
	state.mutate.mockReset().mockResolvedValue({ data: { ok: true } })
})

test('native trigger actions reach the same scoped business operation without actor identity from input', async () => {
	const enablements = [
		{
			trigger: { kind: 'cron' as const, name: 'digest' },
			state: 'on' as const,
			createInstance: true,
		},
	]
	await savePackageCredentialMappings({
		data: { username: 'team', kodyId: 'repo', enablements },
	})
	expect(state.scope).toHaveBeenCalledWith(
		expect.objectContaining({
			username: 'team',
			kodyId: 'repo',
			user: { id: 'actor' },
		}),
	)
	expect(state.mutate).toHaveBeenCalledWith({
		scope: { savedPackage: { id: 'original-package' } },
		body: { changes: undefined, enablements },
	})
})

test('native trigger mutations require a session and package access before writing', async () => {
	const input = {
		data: {
			username: 'team',
			kodyId: 'repo',
			enablements: [
				{
					trigger: { kind: 'cron' as const, name: 'digest' },
					state: 'off' as const,
					enablementId: 'id',
				},
			],
		},
	}
	state.authenticated = false
	await expect(savePackageCredentialMappings(input)).rejects.toThrow(
		'Please sign in again.',
	)
	expect(state.mutate).not.toHaveBeenCalled()
	state.authenticated = true
	state.scope.mockResolvedValue(null)
	await expect(savePackageCredentialMappings(input)).rejects.toThrow(
		'Package not found.',
	)
	expect(state.mutate).not.toHaveBeenCalled()
})

test('empty trigger mutations fail validation before any scope lookup', async () => {
	await expect(
		savePackageCredentialMappings({
			data: { username: 'team', kodyId: 'repo' },
		}),
	).rejects.toThrow('expected { changes } and/or { enablements }')
	expect(state.scope).not.toHaveBeenCalled()
	expect(state.mutate).not.toHaveBeenCalled()
})
