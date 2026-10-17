import type * as RateLimitModule from '#app/rate-limit.ts'
import type * as TwoFactorModule from '#app/two-factor.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	checkAuthRateLimit,
	checkRateLimit,
	twoFactorVerifyRateLimitConfig,
} from '#app/rate-limit.ts'
import {
	verifyTwoFactorCode,
	isTwoFactorEnabled,
	cancelTwoFactorSetup,
} from '#app/two-factor.ts'
import {
	startAccountTwoFactorSetup,
	confirmAccountTwoFactorSetup,
	cancelAccountTwoFactorSetup,
	disableAccountTwoFactor,
} from './account-two-factor.ts'
vi.mock('#app/rate-limit.ts', async (original) => ({
	...(await original<typeof RateLimitModule>()),
	checkAuthRateLimit: vi.fn(),
	checkRateLimit: vi.fn(),
}))
vi.mock('#app/two-factor.ts', async (original) => ({
	...(await original<typeof TwoFactorModule>()),
	verifyTwoFactorCode: vi.fn(),
	isTwoFactorEnabled: vi.fn(),
	cancelTwoFactorSetup: vi.fn(),
}))
const env = { APP_DB: {} } as Env
const user = {
	sessionUserId: 'person-stable',
	userId: 42,
} as AuthenticatedAppUser
const request = new Request('https://kody.test/_serverFn/opaque', {
	headers: { 'CF-Connecting-IP': '192.0.2.1' },
})
beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(checkAuthRateLimit).mockResolvedValue({
		allowed: true,
		retryAfterSeconds: null,
	})
	vi.mocked(checkRateLimit).mockResolvedValue({
		allowed: false,
		retryAfterSeconds: 900,
	})
})
for (const mutate of [
	startAccountTwoFactorSetup,
	confirmAccountTwoFactorSetup,
	cancelAccountTwoFactorSetup,
	disableAccountTwoFactor,
]) {
	test(`${mutate.name} enforces ingress before touching factor state`, async () => {
		vi.mocked(checkAuthRateLimit).mockResolvedValue({
			allowed: false,
			retryAfterSeconds: 60,
		})
		expect(await mutate({ env, request, user, code: '123456' })).toMatchObject({
			ok: false,
			retryAfter: '60',
		})
		expect(checkAuthRateLimit).toHaveBeenCalledWith(env, 'auth:ip:192.0.2.1')
		expect(checkRateLimit).not.toHaveBeenCalled()
		expect(verifyTwoFactorCode).not.toHaveBeenCalled()
		expect(isTwoFactorEnabled).not.toHaveBeenCalled()
		expect(cancelTwoFactorSetup).not.toHaveBeenCalled()
	})
}
test('confirm and disable share a person budget even across different IPs and RPC URLs', async () => {
	for (const mutate of [
		confirmAccountTwoFactorSetup,
		disableAccountTwoFactor,
	]) {
		expect(
			await mutate({
				env,
				request: new Request('https://kody.test/_serverFn/another', {
					headers: { 'CF-Connecting-IP': '192.0.2.2' },
				}),
				user,
				code: '123456',
			}),
		).toMatchObject({ ok: false, retryAfter: '900' })
	}
	expect(checkRateLimit).toHaveBeenCalledTimes(2)
	expect(checkRateLimit).toHaveBeenCalledWith(
		env.APP_DB,
		'auth:2fa-manage:person-stable',
		twoFactorVerifyRateLimitConfig,
	)
	expect(verifyTwoFactorCode).not.toHaveBeenCalled()
	expect(isTwoFactorEnabled).not.toHaveBeenCalled()
})
