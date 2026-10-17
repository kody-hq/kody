import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const deletePasskey = createServerFn({ method: 'POST' })
	.validator(z.object({ passkeyId: z.string() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { deleteAccountPasskey } =
			await import('../../src/app/handlers/account-passkeys.ts')
		return withWebsiteMutation({}, async (context) => {
			const result = await deleteAccountPasskey({ ...context, ...data })
			if ('error' in result) throw new Error(result.error)
			return result
		})
	})
export const renamePasskey = createServerFn({ method: 'POST' })
	.validator(z.object({ passkeyId: z.string(), name: z.string().optional() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { renameAccountPasskey } =
			await import('../../src/app/handlers/account-passkeys.ts')
		return withWebsiteMutation({}, async (context) => {
			const result = await renameAccountPasskey({ ...context, ...data })
			if ('error' in result) throw new Error(result.error)
			return result
		})
	})
export const startTwoFactorSetup = createServerFn({ method: 'POST' })
	.validator(z.object({}))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { startAccountTwoFactorSetup } =
			await import('../../src/app/handlers/account-two-factor.ts')
		return withWebsiteMutation({}, async (context) => {
			const result = await startAccountTwoFactorSetup({ ...context, ...data })
			if ('retryAfter' in result) {
				const { setResponseHeader } =
					await import('@tanstack/react-start/server')
				setResponseHeader('Retry-After', result.retryAfter)
			}
			return result
		})
	})
export const confirmTwoFactorSetup = createServerFn({ method: 'POST' })
	.validator(z.object({ code: z.string() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { confirmAccountTwoFactorSetup } =
			await import('../../src/app/handlers/account-two-factor.ts')
		return withWebsiteMutation({}, async (context) => {
			const result = await confirmAccountTwoFactorSetup({ ...context, ...data })
			if ('retryAfter' in result) {
				const { setResponseHeader } =
					await import('@tanstack/react-start/server')
				setResponseHeader('Retry-After', result.retryAfter)
			}
			return result
		})
	})
export const cancelTwoFactorSetup = createServerFn({ method: 'POST' })
	.validator(z.object({}))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { cancelAccountTwoFactorSetup } =
			await import('../../src/app/handlers/account-two-factor.ts')
		return withWebsiteMutation({}, async (context) => {
			const result = await cancelAccountTwoFactorSetup({ ...context, ...data })
			if ('retryAfter' in result) {
				const { setResponseHeader } =
					await import('@tanstack/react-start/server')
				setResponseHeader('Retry-After', result.retryAfter)
			}
			return result
		})
	})
export const disableTwoFactor = createServerFn({ method: 'POST' })
	.validator(z.object({ code: z.string() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { disableAccountTwoFactor } =
			await import('../../src/app/handlers/account-two-factor.ts')
		return withWebsiteMutation({}, async (context) => {
			const result = await disableAccountTwoFactor({ ...context, ...data })
			if ('retryAfter' in result) {
				const { setResponseHeader } =
					await import('@tanstack/react-start/server')
				setResponseHeader('Retry-After', result.retryAfter)
			}
			return result
		})
	})
export const changePassword = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			currentPassword: z.string().optional(),
			newPassword: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { changeAccountPassword } =
			await import('../../src/app/handlers/account-password.ts')
		const { setResponseHeader } = await import('@tanstack/react-start/server')
		return withWebsiteMutation({}, async (context) => {
			const result = await changeAccountPassword({ ...context, body: data })
			if (result.sessionCookie)
				setResponseHeader('Set-Cookie', result.sessionCookie)
			if (result.retryAfter) setResponseHeader('Retry-After', result.retryAfter)
			return result.payload
		})
	})

export const deleteOwnAccount = createServerFn({ method: 'POST' })
	.validator(
		z.object({ confirmation: z.string(), password: z.string().optional() }),
	)
	.handler(async ({ data }) => {
		const { env } = await import('cloudflare:workers')
		const { getEnv } = await import('#app/env.ts')
		const { getRequest, setResponseHeader } =
			await import('@tanstack/react-start/server')
		const { readAuthenticatedAppUserForDeletion } =
			await import('#app/authenticated-user.ts')
		const { deleteAccount } =
			await import('../../src/app/handlers/account-delete.ts')
		const request = getRequest()
		const bindings = getEnv(env)
		const user = await readAuthenticatedAppUserForDeletion(request, bindings)
		if (!user) throw new Error('Please sign in again.')
		// Deletion acquires its exclusive lifecycle lock itself, never a normal write lease.
		const result = await deleteAccount({
			env: bindings,
			request,
			user,
			body: data,
		})
		if ('sessionCookie' in result && result.sessionCookie)
			setResponseHeader('Set-Cookie', result.sessionCookie)
		return result.payload
	})

export const signOut = createServerFn({ method: 'POST' }).handler(async () => {
	const { getRequest, setResponseHeader } =
		await import('@tanstack/react-start/server')
	const { destroyAuthCookie, isSecureRequest, setAuthSessionSecret } =
		await import('#app/auth-session.ts')
	const { env } = await import('cloudflare:workers')
	const { getEnv } = await import('#app/env.ts')
	setAuthSessionSecret(getEnv(env).COOKIE_SECRET)
	setResponseHeader(
		'Set-Cookie',
		await destroyAuthCookie(isSecureRequest(getRequest())),
	)
	return { ok: true }
})
