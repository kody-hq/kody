import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	authenticated: true,
	viewer: vi.fn(),
	load: vi.fn(),
	decide: vi.fn(),
	lease: vi.fn(),
	status: vi.fn(),
	header: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let schema: { parse: (value: unknown) => unknown }
		const builder = {
			validator(value: typeof schema) {
				schema = value
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return (input: { data: unknown }) =>
					run({ data: schema.parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('@tanstack/react-router', () => ({
	notFound: () => ({ notFound: true }),
	redirect: (options: unknown) => ({ redirect: options }),
}))
vi.mock('@tanstack/react-start/server', () => ({
	setResponseStatus: state.status,
	setResponseHeader: state.header,
}))
vi.mock('./mutation-context.ts', () => {
	class WebsiteAuthenticationError extends Error {}
	const read = async (
		_: unknown,
		run: (context: unknown) => Promise<unknown>,
	) => {
		if (!state.authenticated) throw new WebsiteAuthenticationError()
		return run({
			request: new Request('https://kody.test/_serverFn/test'),
			env: {},
			user: { request: { org: { id: 'personal' } } },
		})
	}
	return {
		WebsiteAuthenticationError,
		withWebsiteRead: read,
		withWebsiteMutation: async (
			options: unknown,
			run: (context: unknown) => Promise<unknown>,
		) => {
			state.lease()
			return read(options, run)
		},
	}
})
vi.mock('../../src/app/approval-bundle-decisions.ts', () => ({
	loadApprovalViewerForSlug: state.viewer,
	decideApprovalBundleItem: state.decide,
}))
vi.mock('../../src/approval-bundles/service.ts', () => ({
	loadApprovalBundleView: state.load,
}))
import { decideApprovalBundle, loadApprovalBundle } from './approval-bundles.ts'
const input = { orgSlug: 'team', bundleId: 'bundle-1' }
beforeEach(() => {
	vi.clearAllMocks()
	state.authenticated = true
	state.viewer.mockResolvedValue({ request: { org: { id: 'team-org' } } })
	state.load.mockResolvedValue({
		ok: true,
		view: { bundle: { id: 'bundle-1' }, groups: [] },
	})
	state.decide.mockResolvedValue({
		status: 409,
		body: { ok: false, error: 'Changed since review.', item: null },
	})
})
test('reads the authorized bundle and marks its response noindex', async () => {
	await expect(loadApprovalBundle({ data: input })).resolves.toMatchObject({
		ok: true,
	})
	expect(state.viewer).toHaveBeenCalledWith(
		expect.objectContaining({ orgSlug: 'team' }),
	)
	expect(state.header).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow')
})
test('expired bundles retain typed UI data and a 410 document status', async () => {
	state.load.mockResolvedValue({ ok: false, reason: 'expired' })
	await expect(loadApprovalBundle({ data: input })).resolves.toEqual({
		ok: false,
		reason: 'expired',
	})
	expect(state.status).toHaveBeenCalledWith(410)
})
test('outsiders cannot load another organization bundle', async () => {
	state.viewer.mockResolvedValue(null)
	await expect(loadApprovalBundle({ data: input })).rejects.toEqual({
		notFound: true,
	})
	expect(state.load).not.toHaveBeenCalled()
})
test('anonymous reads preserve the requested bundle through login', async () => {
	state.authenticated = false
	await expect(loadApprovalBundle({ data: input })).rejects.toEqual({
		redirect: {
			href: '/login?redirectTo=%2F%40team%2F-%2Fapprovals%2Fbundle-1',
		},
	})
})
test('decisions run under the write lease and pass the bound user to existing security checks', async () => {
	const decision = {
		action: 'approve' as const,
		item: 'capabilities:pkg',
		fingerprint: 'reviewed',
	}
	await expect(
		decideApprovalBundle({ data: { ...input, ...decision } }),
	).resolves.toEqual({ ok: false, error: 'Changed since review.', item: null })
	expect(state.lease).toHaveBeenCalledOnce()
	expect(state.decide).toHaveBeenCalledWith(
		expect.objectContaining({
			user: { request: { org: { id: 'team-org' } } },
			bundleId: 'bundle-1',
			decision,
		}),
	)
})
test('outsider decisions never reach the business operation', async () => {
	state.viewer.mockResolvedValue(null)
	await expect(
		decideApprovalBundle({
			data: { ...input, action: 'deny', item: 'x', fingerprint: 'x' },
		}),
	).resolves.toMatchObject({ ok: false, item: null })
	expect(state.decide).not.toHaveBeenCalled()
})
