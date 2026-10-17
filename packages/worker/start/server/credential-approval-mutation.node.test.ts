import { parseCredentialApprovalQuery } from '#universal/credential-contracts.ts'
import { expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ loadScope: vi.fn(), approve: vi.fn() }))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let validator: { parse: (data: unknown) => unknown }
		const builder = {
			validator(next: typeof validator) {
				validator = next
				return builder
			},
			handler(run: (input: { data: unknown }) => unknown) {
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
		run: (context: unknown) => unknown,
	) =>
		run({
			env: {},
			request: new Request('https://kody.test/_server'),
			user: { id: 'viewer' },
		}),
}))
vi.mock('../../src/app/package-credentials-access.ts', () => ({
	loadPackageMappingScopeForViewer: mocks.loadScope,
}))
vi.mock('../../src/credentials/credential-approval.ts', () => ({
	approveCredentialProposal: mocks.approve,
}))
import { approvePackageCredentials } from './credential-approval-mutation.ts'
const scope = { baseUrl: 'https://kody.test' }
const view = { ok: true, canApprove: true, fingerprint: 'f1' }
const data = {
	username: 'acme',
	kodyId: 'digest',
	proposal: parseCredentialApprovalQuery(
		new URLSearchParams('mine[mail]=resend-prod&reason=Digest'),
	),
	fingerprint: 'f1',
}
test('credential approval validates, enforces execute scope and preserves every outcome', async () => {
	mocks.loadScope.mockResolvedValue(scope)
	await expect(
		approvePackageCredentials({ data: { ...data, fingerprint: '' } }),
	).rejects.toThrow()
	expect(mocks.approve).not.toHaveBeenCalled()
	mocks.loadScope.mockResolvedValueOnce(null)
	await expect(approvePackageCredentials({ data })).rejects.toThrow(
		'Package not found.',
	)
	mocks.approve.mockResolvedValueOnce({ status: 'approved', view })
	expect(await approvePackageCredentials({ data })).toEqual({ ok: true, view })
	expect(mocks.approve).toHaveBeenCalledWith(
		expect.objectContaining({
			scope,
			fingerprint: 'f1',
			proposal: expect.objectContaining({
				changes: [
					{
						target: { type: 'default', layer: 'mine' },
						needKey: 'mail',
						credentials: [{ name: 'resend-prod' }],
					},
				],
				reason: 'Digest',
			}),
		}),
	)
	mocks.approve.mockResolvedValueOnce({ status: 'invalid', view })
	expect(await approvePackageCredentials({ data })).toMatchObject({
		ok: false,
		view,
	})
	mocks.approve.mockResolvedValueOnce({ status: 'stale', view })
	expect(await approvePackageCredentials({ data })).toMatchObject({
		ok: false,
		view,
		error: expect.stringContaining('changed since you reviewed'),
	})
	mocks.approve.mockResolvedValueOnce({
		status: 'conflict',
		view,
		message: 'Webhook incoming is already on for another person.',
	})
	expect(await approvePackageCredentials({ data })).toEqual({
		ok: false,
		view,
		error: 'Webhook incoming is already on for another person.',
	})
})

test('native approval forwards the selected webhook endpoint to scoped business approval', async () => {
	mocks.loadScope.mockResolvedValue(scope)
	mocks.approve.mockResolvedValue({ status: 'approved', view })
	const proposal = parseCredentialApprovalQuery(
		new URLSearchParams('enable=webhook:incoming:endpoint-staging'),
	)
	expect(
		await approvePackageCredentials({ data: { ...data, proposal } }),
	).toEqual({ ok: true, view })
	expect(mocks.approve).toHaveBeenLastCalledWith(
		expect.objectContaining({ scope, proposal }),
	)
})
