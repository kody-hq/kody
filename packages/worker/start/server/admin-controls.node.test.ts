import { beforeEach, expect, test, vi } from 'vitest'
const state = vi.hoisted(() => ({
	role: vi.fn(),
	permission: vi.fn(),
	readLimits: vi.fn(),
	writeLimits: vi.fn(),
	header: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerFn: () => {
		let parse = (data: unknown) => data
		const builder = {
			inputValidator(schema: { parse: (data: unknown) => unknown }) {
				parse = schema.parse.bind(schema)
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return (input: { data: unknown }) => run({ data: parse(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', () => ({
	env: { APP_DB: {}, COOKIE_SECRET: 'test' },
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://kody.test/_serverFn/admin'),
	setResponseHeader: state.header,
}))
vi.mock('../../src/app/env.ts', () => ({ getEnv: (env: unknown) => env }))
vi.mock('../../src/app/auth-session.ts', () => ({
	setAuthSessionSecret: vi.fn(),
}))
vi.mock('../../src/app/permissions-server.ts', () => ({
	requireUserWithRole: state.role,
	requireUserWithPermission: state.permission,
}))
vi.mock('./mutation-context.ts', () => ({
	withWebsiteMutation: async (_: unknown, write: () => Promise<unknown>) =>
		write(),
}))
vi.mock('../../src/admin/org-limit-overrides.ts', () => ({
	loadAdminOrgLimits: state.readLimits,
	applyAdminOrgLimitOverrideChanges: state.writeLimits,
}))
import {
	grantAdminCreditsToOrg,
	readAdminOrgLimits,
	setAdminOrgCreditEligibility,
	setAdminOrgPlan,
	updateAdminOrgLimits,
} from './admin-controls.ts'
beforeEach(() => vi.clearAllMocks())
test('native admin limit reads and writes refuse non-admins before domain access', async () => {
	state.role.mockRejectedValue(new Error('Forbidden'))
	await expect(readAdminOrgLimits({ data: { orgId: 'org' } })).rejects.toThrow(
		'Forbidden',
	)
	await expect(
		updateAdminOrgLimits({
			data: {
				orgId: 'org',
				changes: [{ key: 'outbound_fetches_per_day', value: 'unlimited' }],
				reason: 'not an admin',
			},
		}),
	).rejects.toThrow('Forbidden')
	expect(state.readLimits).not.toHaveBeenCalled()
	expect(state.writeLimits).not.toHaveBeenCalled()
	expect(state.header).toHaveBeenCalledWith(
		'Cache-Control',
		'private, no-store',
	)
})

test('organization billing mutations refuse non-admins before domain access', async () => {
	state.role.mockRejectedValue(new Error('Forbidden'))
	await expect(
		setAdminOrgPlan({
			data: { orgId: 'org', plan: 'pro', reason: 'Support approval.' },
		}),
	).rejects.toThrow('Forbidden')
	await expect(
		grantAdminCreditsToOrg({
			data: { orgId: 'org', amountCents: 100, reason: 'Support approval.' },
		}),
	).rejects.toThrow('Forbidden')
	await expect(
		setAdminOrgCreditEligibility({
			data: {
				orgId: 'org',
				creditsEligible: true,
				reason: 'Support approval.',
			},
		}),
	).rejects.toThrow('Forbidden')
})
