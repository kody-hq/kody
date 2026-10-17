import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const authenticateWebsite = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [
			{ authenticateWebsite: operation },
			{ publishAuthResult, publicAuthContext },
		] = await Promise.all([
			import('../../src/identity/auth-operations.ts'),
			import('./auth-mutation-context.ts'),
		])
		const { env, request } = await publicAuthContext()
		return publishAuthResult(
			await operation({
				env,
				request,
				url: new URL('/login', request.url),
				body: data,
			}),
		)
	})

export const requestWebsitePasswordReset = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [
			{ requestWebsitePasswordReset: operation },
			{ publishAuthResult, publicAuthContext },
		] = await Promise.all([
			import('../../src/identity/password-reset-operations.ts'),
			import('./auth-mutation-context.ts'),
		])
		const { env, request } = await publicAuthContext()
		return publishAuthResult(
			await operation({
				env,
				request,
				url: new URL('/reset-password', request.url),
				body: data,
			}),
		)
	})

export const confirmWebsitePasswordReset = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [
			{ confirmWebsitePasswordReset: operation },
			{ publishAuthResult, publicAuthContext },
		] = await Promise.all([
			import('../../src/identity/password-reset-operations.ts'),
			import('./auth-mutation-context.ts'),
		])
		const { env, request } = await publicAuthContext()
		return publishAuthResult(
			await operation({
				env,
				request,
				url: new URL('/reset-password', request.url),
				body: data,
			}),
		)
	})

export const verifyWebsiteTwoFactor = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [
			{ verifyWebsiteTwoFactor: operation },
			{ publishAuthResult, publicAuthContext },
		] = await Promise.all([
			import('../../src/identity/verify-operations.ts'),
			import('./auth-mutation-context.ts'),
		])
		const { env, request } = await publicAuthContext()
		return publishAuthResult(
			await operation({
				env,
				request,
				url: new URL('/verify', request.url),
				body: data,
			}),
		)
	})

export const requestWebsiteEmailChange = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [{ requestWebsiteEmailChange: operation }, { publishAuthResult }] =
			await Promise.all([
				import('../../src/identity/account-email-change-operations.ts'),
				import('./auth-mutation-context.ts'),
			])
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request }) =>
			publishAuthResult(
				await operation({
					env,
					request,
					url: new URL('/account', request.url),
					body: data,
				}),
			),
		)
	})

export const requestWebsiteEmailRelease = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [{ requestWebsiteEmailRelease: operation }, { publishAuthResult }] =
			await Promise.all([
				import('../../src/identity/account-email-claim-release-operations.ts'),
				import('./auth-mutation-context.ts'),
			])
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request }) =>
			publishAuthResult(
				await operation({
					env,
					request,
					url: new URL('/account', request.url),
					body: data,
				}),
			),
		)
	})

export const resendWebsiteVerification = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [{ resendWebsiteVerification: operation }, { publishAuthResult }] =
			await Promise.all([
				import('../../src/identity/account-resend-verification-operations.ts'),
				import('./auth-mutation-context.ts'),
			])
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request }) =>
			publishAuthResult(
				await operation({
					env,
					request,
					url: new URL('/account', request.url),
					body: data,
				}),
			),
		)
	})

export const webauthnRegistrationOptions = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [{ webauthnRegistrationOptions: operation }, { publishAuthResult }] =
			await Promise.all([
				import('../../src/identity/webauthn-operations.ts'),
				import('./auth-mutation-context.ts'),
			])
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request }) =>
			publishAuthResult(
				await operation({
					env,
					request,
					url: new URL('/account/security', request.url),
					body: data,
				}),
			),
		)
	})

export const webauthnRegistrationVerify = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [{ webauthnRegistrationVerify: operation }, { publishAuthResult }] =
			await Promise.all([
				import('../../src/identity/webauthn-operations.ts'),
				import('./auth-mutation-context.ts'),
			])
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		return withWebsiteMutation({}, async ({ env, request }) =>
			publishAuthResult(
				await operation({
					env,
					request,
					url: new URL('/account/security', request.url),
					body: {
						...data,
						response: data.response as Parameters<
							typeof operation
						>[0]['body']['response'],
					},
				}),
			),
		)
	})

export const webauthnAuthenticationOptions = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [
			{ webauthnAuthenticationOptions: operation },
			{ publishAuthResult, publicAuthContext },
		] = await Promise.all([
			import('../../src/identity/webauthn-operations.ts'),
			import('./auth-mutation-context.ts'),
		])
		const { env, request } = await publicAuthContext()
		return publishAuthResult(
			await operation({
				env,
				request,
				url: new URL('/login', request.url),
				body: data,
			}),
		)
	})

export const webauthnAuthenticationVerify = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [
			{ webauthnAuthenticationVerify: operation },
			{ publishAuthResult, publicAuthContext },
		] = await Promise.all([
			import('../../src/identity/webauthn-operations.ts'),
			import('./auth-mutation-context.ts'),
		])
		const { env, request } = await publicAuthContext()
		return publishAuthResult(
			await operation({
				env,
				request,
				url: new URL('/login', request.url),
				body: {
					...data,
					response: data.response as Parameters<
						typeof operation
					>[0]['body']['response'],
				},
			}),
		)
	})

export const readWebsiteAuthProviders = createServerFn({
	method: 'GET',
}).handler(async () => {
	const [{ env }, { getEnv }, { publicAuthProvidersLoaderData }] =
		await Promise.all([
			import('cloudflare:workers'),
			import('../../src/app/env.ts'),
			import('../../src/app/public-auth-providers.ts'),
		])
	return publicAuthProvidersLoaderData(getEnv(env))
})
export const startWebsiteOAuth = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({
			provider: z.string(),
			search: z.string(),
			body: z.object({
				kody_hp: z.string().optional(),
				turnstileToken: z.string().optional(),
			}),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ startWebsiteOAuth: operation },
			{ publicAuthContext, publishAuthResult },
		] = await Promise.all([
			import('../../src/identity/oauth-start-operation.ts'),
			import('./auth-mutation-context.ts'),
		])
		const { request, env } = await publicAuthContext()
		const url = new URL('/login', request.url)
		url.search = data.search
		return publishAuthResult(
			await operation({
				env,
				request,
				url,
				body: data.body,
				provider: data.provider,
			}),
		)
	})
