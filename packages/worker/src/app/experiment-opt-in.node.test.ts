import { expect, test, vi } from 'vitest'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
const mocks = vi.hoisted(() => ({
	setFeatureFlagUserOverride: vi.fn(async () => undefined),
}))
vi.mock('#worker/feature-flags/service.ts', () => ({
	setFeatureFlagUserOverride: mocks.setFeatureFlagUserOverride,
}))
import { setWebsiteExperiment } from './experiment-opt-in.ts'

test.each([
	['package-skills', 'mcp-skills-extension', true],
	['mcp-events', 'mcp-events-extension', true],
	['execution-contexts', 'execution-contexts', true],
	['execution-contexts', 'execution-contexts', false],
] as const)(
	'setting %s (%s) to %s changes only the authenticated user override and records the audit',
	async (experiment, key, enabled) => {
		mocks.setFeatureFlagUserOverride.mockClear()
		logAuditEventSpy.mockClear()
		const env = { APP_DB: {} } as Env
		expect(
			await setWebsiteExperiment({
				env,
				request: new Request('https://kody.example/_serverFn/optin'),
				user: { userId: 7, email: 'jane@example.com' },
				experiment,
				enabled,
			}),
		).toEqual({ ok: true, enabled })
		expect(mocks.setFeatureFlagUserOverride).toHaveBeenCalledWith(env.APP_DB, {
			key,
			userId: 7,
			enabled,
			updatedBy: 7,
		})
		expect(logAuditEventSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				category: 'account',
				action: enabled
					? 'feature_flag_self_opt_in'
					: 'feature_flag_self_opt_out',
				result: 'success',
				email: 'jane@example.com',
				path: '/account/experiments',
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
		setWebsiteExperiment({
			env: { APP_DB: {} } as Env,
			request: new Request('https://kody.example/_serverFn/optin'),
			user: { userId: 7, email: 'jane@example.com' },
			experiment: 'package-skills',
			enabled: true,
		}),
	).rejects.toThrow('database unavailable')
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})
