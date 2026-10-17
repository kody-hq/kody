import { packageWebhookApprovalHref } from '../package-webhook-approval.ts'
import { packageWebhookInput } from '#universal/package-access-mutations.ts'
import { createServerFn } from '@tanstack/react-start'
import { notFound, redirect } from '@tanstack/react-router'
export const loadPackageWebhooks = createServerFn({ method: 'GET' })
	.validator((input: { username: string; kodyId: string }) => {
		if (
			!input ||
			typeof input.username !== 'string' ||
			typeof input.kodyId !== 'string' ||
			!input.username ||
			!input.kodyId
		)
			throw new Error('Invalid package')
		return { username: input.username, kodyId: input.kodyId }
	})
	.handler(async ({ data }) => {
		const [
			{ env },
			{ getRequest, setResponseHeader },
			{ getEnv },
			{ setAuthSessionSecret },
			{ readPackageWebhooksData },
		] = await Promise.all([
			import('cloudflare:workers'),
			import('@tanstack/react-start/server'),
			import('../../src/app/env.ts'),
			import('../../src/app/auth-session.ts'),
			import('../../src/app/handlers/package-webhooks.ts'),
		])
		const bindings = getEnv(env)
		setAuthSessionSecret(bindings.COOKIE_SECRET)
		setResponseHeader('Cache-Control', 'no-store')
		const original = getRequest()
		const result = await readPackageWebhooksData(original, data, bindings)

		if (result.status === 401) throw redirect({ href: '/login' })
		if (result.status === 404) throw notFound()
		if (!result.data.ok) return result.data
		const payload = result.data
		return {
			...result.data,
			webhooks: result.data.webhooks.map((webhook) => ({
				...webhook,
				approvalUrl: packageWebhookApprovalHref({
					username: payload.username,
					kodyId: payload.kodyId,
					webhookName: webhook.name,
					approvalUrl: webhook.approvalUrl,
					endpointId: webhook.endpointId,
				}),
			})),
		}
	})

export const mintPackageWebhook = createServerFn({ method: 'POST' })
	.validator(packageWebhookInput)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { mintPackageWebhook } =
			await import('../../src/app/handlers/package-webhooks.ts')
		return withWebsiteMutation(
			{},
			async ({ request, env }) =>
				(
					await mintPackageWebhook({
						request,
						env,
						params: { username: data.username, kodyId: data.kodyId },
						webhookName: data.webhookName,
						endpointId: data.endpointId,
						createInstance: data.createInstance,
						instanceLabel: data.instanceLabel,
					})
				).data,
		)
	})
export const rotatePackageWebhook = createServerFn({ method: 'POST' })
	.validator(packageWebhookInput)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { rotatePackageWebhook } =
			await import('../../src/app/handlers/package-webhooks.ts')
		return withWebsiteMutation(
			{},
			async ({ request, env }) =>
				(
					await rotatePackageWebhook({
						request,
						env,
						params: { username: data.username, kodyId: data.kodyId },
						webhookName: data.webhookName,
						endpointId: data.endpointId,
						createInstance: data.createInstance,
						instanceLabel: data.instanceLabel,
					})
				).data,
		)
	})
export const revealPackageWebhook = createServerFn({ method: 'POST' })
	.validator(packageWebhookInput)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { revealPackageWebhook } =
			await import('../../src/app/handlers/package-webhooks.ts')
		return withWebsiteMutation(
			{},
			async ({ request, env }) =>
				(
					await revealPackageWebhook({
						request,
						env,
						params: { username: data.username, kodyId: data.kodyId },
						webhookName: data.webhookName,
						endpointId: data.endpointId,
						createInstance: data.createInstance,
						instanceLabel: data.instanceLabel,
					})
				).data,
		)
	})
export const enablePackageWebhook = createServerFn({ method: 'POST' })
	.validator(packageWebhookInput)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { enablePackageWebhook } =
			await import('../../src/app/handlers/package-webhooks.ts')
		return withWebsiteMutation(
			{},
			async ({ request, env }) =>
				(
					await enablePackageWebhook({
						request,
						env,
						params: { username: data.username, kodyId: data.kodyId },
						webhookName: data.webhookName,
						endpointId: data.endpointId,
						createInstance: data.createInstance,
						instanceLabel: data.instanceLabel,
					})
				).data,
		)
	})
export const disablePackageWebhook = createServerFn({ method: 'POST' })
	.validator(packageWebhookInput)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { disablePackageWebhook } =
			await import('../../src/app/handlers/package-webhooks.ts')
		return withWebsiteMutation(
			{},
			async ({ request, env }) =>
				(
					await disablePackageWebhook({
						request,
						env,
						params: { username: data.username, kodyId: data.kodyId },
						webhookName: data.webhookName,
						endpointId: data.endpointId,
						createInstance: data.createInstance,
						instanceLabel: data.instanceLabel,
					})
				).data,
		)
	})
