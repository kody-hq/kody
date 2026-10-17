import { expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	request: new Request('https://kody.test/_serverFn/package', {
		method: 'POST',
	}),
	operation: vi.fn(async (_input: unknown) => ({
		status: 409,
		data: {
			ok: false,
			error: 'Review changed',
			approvalUrl: '/@team/repo/approve-capabilities',
		},
	})),
	status: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse(data: unknown): unknown }
		const builder = {
			validator(next: typeof schema) {
				schema = next
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
vi.mock('@tanstack/react-start/server', () => ({
	setResponseStatus: state.status,
}))
vi.mock('../../src/app/account-package-publish-lock.ts', () => ({
	lockAccountPackage: state.operation,
	unlockAccountPackage: state.operation,
	approveAccountPackagePublish: state.operation,
}))
vi.mock('../../src/app/account-package-visibility.ts', () => ({
	setAccountPackageVisibility: state.operation,
}))
vi.mock('../../src/app/account-package-capability-approval.ts', () => ({
	setAccountPackageInternetVisible: state.operation,
	approveAccountPackageCapabilities: state.operation,
	approveAccountPackageCapabilitiesAndGoPublic: state.operation,
	approveAccountPackageCredentialNeeds: state.operation,
	approveAccountPackageWentPublic: state.operation,
}))
vi.mock('../../src/app/account-package-delete.ts', () => ({
	deleteAccountPackage: state.operation,
}))
vi.mock('../../src/app/account-package-adopt.ts', () => ({
	adoptAccountPackageFork: state.operation,
}))
import * as operations from './package-mutations.ts'
test('named package operations keep the original request and domain error status', async () => {
	await operations.approvePackageCapabilities({
		data: { packageId: 'pkg', fingerprint: 'reviewed' },
	})
	expect(state.operation).toHaveBeenLastCalledWith({
		request: state.request,
		env: {},
		user: {},
		packageId: 'pkg',
		fingerprint: 'reviewed',
	})
	expect(state.status).toHaveBeenLastCalledWith(409)
	await expect(
		operations.setPackageInternetVisible({
			data: { packageId: 'pkg', internetVisible: true, confirmName: 'repo' },
		}),
	).resolves.toMatchObject({
		ok: false,
		approvalUrl: '/@team/repo/approve-capabilities',
	})
	expect(state.operation).toHaveBeenLastCalledWith({
		request: state.request,
		env: {},
		user: {},
		packageId: 'pkg',
		internetVisible: true,
		confirmName: 'repo',
	})
})
test('native operation validators reject missing identity and strip action dispatch fields', async () => {
	expect(() =>
		operations.approvePackagePublish({
			data: { packageId: '', commit: 'abc' },
		}),
	).toThrow()
	const data = {
		packageId: 'pkg',
		visibility: 'public' as const,
		confirmName: 'repo',
		action: 'delete',
	}
	await operations.setPackageVisibility({ data })
	expect(state.operation).toHaveBeenLastCalledWith({
		request: state.request,
		env: {},
		user: {},
		packageId: 'pkg',
		visibility: 'public',
		confirmName: 'repo',
	})
})

test('combined approval validates the request identity and preserves it at the authenticated boundary', async () => {
	await operations.approvePackageCapabilitiesAndGoPublic({
		data: { packageId: 'pkg', fingerprint: 'reviewed', requestId: 'request-1' },
	})
	expect(state.operation).toHaveBeenLastCalledWith({
		request: state.request,
		env: {},
		user: {},
		packageId: 'pkg',
		fingerprint: 'reviewed',
		requestId: 'request-1',
	})
	expect(() =>
		operations.approvePackageCapabilitiesAndGoPublic({
			data: { packageId: 'pkg', fingerprint: 'reviewed', requestId: '' },
		}),
	).toThrow()
})

test('native approval refuses legacy action dispatch fields before any business mutation', () => {
	state.operation.mockClear()
	for (const action of ['not-a-real-action', 'set-internet-visible', null]) {
		expect(() =>
			operations.approvePackageCapabilities({
				data: { packageId: 'pkg', fingerprint: 'reviewed', action } as never,
			}),
		).toThrow('Unrecognized key')
	}
	expect(state.operation).not.toHaveBeenCalled()
})
