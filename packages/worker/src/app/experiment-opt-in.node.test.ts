import { expect, test, vi } from 'vitest'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
const mocks = vi.hoisted(() => ({
	setFeatureFlagUserOverride: vi.fn(async () => undefined),
}))
vi.mock('#worker/feature-flags/service.ts', () => ({
	setFeatureFlagUserOverride: mocks.setFeatureFlagUserOverride,
}))
import { optIntoWebsiteExperiment } from './experiment-opt-in.ts'

test.each([
	['package-skills', 'mcp-skills-extension'],
	['mcp-events', 'mcp-events-extension'],
] as const)(
	'opting into %s changes only the authenticated user override and records the audit',
	async (experiment, key) => {
		mocks.setFeatureFlagUserOverride.mockClear()
		logAuditEventSpy.mockClear()
		const env = { APP_DB: {} } as Env
		expect(
			await optIntoWebsiteExperiment({
				env,
				request: new Request('https://kody.example/_serverFn/optin'),
				user: { userId: 7, email: 'jane@example.com' },
				experiment,
			}),
		).toEqual({ ok: true })
		expect(mocks.setFeatureFlagUserOverride).toHaveBeenCalledWith(env.APP_DB, {
			key,
			userId: 7,
			enabled: true,
			updatedBy: 7,
		})
		expect(logAuditEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				category: 'account',
				action: 'feature_flag_self_opt_in',
				result: 'success',
				email: 'jane@example.com',
				path: `/docs/${experiment}`,
				reason: `key=${key}`,
			}),
		)
	},
)

test('failed opt-in is not audited as success', async () => {
	logAuditEventSpy.mockClear()
	mocks.setFeatureFlagUserOverride.mockRejectedValueOnce(
		new Error('database unavailable'),
	)
	await expect(
		optIntoWebsiteExperiment({
			env: { APP_DB: {} } as Env,
			request: new Request('https://kody.example/_serverFn/optin'),
			user: { userId: 7, email: 'jane@example.com' },
			experiment: 'package-skills',
		}),
	).rejects.toThrow('database unavailable')
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})
