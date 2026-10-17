import { z } from 'zod'
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start'
import { redirect, notFound } from '@tanstack/react-router'
import {
	connectSecretsSchema,
	connectOauthSchema,
	connectWebhookSchema,
} from '../connect-input.ts'
async function context(
	path:
		| '/connect/secrets'
		| '/connect/oauth'
		| '/connect/webhook-apply'
		| '/connect/secret-set',
	input: { orgSlug?: string; search: [string, string][] },
) {
	const { withWebsiteRead, WebsiteAuthenticationError } =
		await import('./mutation-context.ts')
	const { loadDocumentHead } = await import('./document-head.ts')
	const search = new URLSearchParams(input.search).toString()
	const href = path + (search ? `?${search}` : '')
	try {
		return await withWebsiteRead(
			{ scope: input.orgSlug ? { orgSlug: input.orgSlug } : undefined },
			async ({ env: bindings, request, user }) => ({
				bindings,
				request,
				user,
				loadDocumentHead,
				search: search ? `?${search}` : '',
			}),
		)
	} catch (error) {
		if (error instanceof WebsiteAuthenticationError)
			throw redirect({
				href: `/login?redirectTo=${encodeURIComponent(href)}`,
				statusCode: 302,
			})
		if (error instanceof Error && error.message === 'Organization not found.')
			throw notFound()
		throw error
	}
}
export const readConnectSecrets = createServerOnlyFn(
	async function readConnectSecrets(
		path: '/connect/secrets' | '/connect/secret-set',
		data: z.infer<typeof connectSecretsSchema>,
	) {
		const { bindings, user, loadDocumentHead, search } = await context(
			path,
			data,
		)
		const { loadAccountSecretsSelection } =
			await import('../../src/app/account-secrets-data.ts')
		const payload = await loadAccountSecretsSelection({
			env: bindings,
			user,
			selectedSecretId: data.selectedSecretId,
			approval: data.approval,
		})
		return {
			payload,
			head: loadDocumentHead(
				path === '/connect/secrets' ? 'connectSecrets' : 'connectSecretSet',
				path,
				{ accountSecrets: payload },
				search,
			),
		}
	},
)
export const loadConnectSecrets = createServerFn({ method: 'GET' })
	.validator(connectSecretsSchema)
	.handler(({ data }) => readConnectSecrets('/connect/secrets', data))
export const loadConnectWebhookApply = createServerFn({ method: 'GET' })
	.validator(connectWebhookSchema)
	.handler(async ({ data }) => {
		const { bindings, user, loadDocumentHead, search } = await context(
			'/connect/webhook-apply',
			data,
		)
		const { loadConnectWebhookApplyData } =
			await import('../../src/app/connect-webhook-apply-data.ts')
		const payload = await loadConnectWebhookApplyData({
			env: bindings,
			user,
			handle: data.handle,
			fingerprint: data.fingerprint,
		})
		return {
			payload,
			head: loadDocumentHead(
				'connectWebhookApply',
				'/connect/webhook-apply',
				{ connectWebhookApply: payload },
				search,
			),
		}
	})
export const loadConnectOauth = createServerFn({ method: 'GET' })
	.validator((input: z.input<typeof connectOauthSchema>) => {
		const result = connectOauthSchema.safeParse(input)
		if (!result.success) {
			if (result.error.issues.some((issue) => issue.path[0] === 'orgSlug'))
				throw notFound()
			throw result.error
		}
		return result.data
	})
	.handler(async ({ data }) => {
		const { loadConnectOauthLoaderData } =
			await import('../../src/app/handlers/connect-oauth.ts')
		if (!data.provider?.trim() && (data.code || data.error)) {
			if (data.orgSlug) {
				const { verifySession } = await import('./shell.ts')
				await verifySession({ data: { orgSlug: data.orgSlug } })
			}

			const [
				{ getRequest, setResponseHeader },
				{ env },
				{ getEnv },
				{ loadDocumentHead },
			] = await Promise.all([
				import('@tanstack/react-start/server'),
				import('cloudflare:workers'),
				import('#app/env.ts'),
				import('./document-head.ts'),
			])
			setResponseHeader('Cache-Control', 'private, no-store')
			const payload = await loadConnectOauthLoaderData(
				getEnv(env),
				getRequest(),
				data,
			)
			const search = new URLSearchParams(data.search).toString()
			return {
				payload,
				head: loadDocumentHead(
					'connectOauth',
					'/connect/oauth',
					{ connectOauth: payload },
					search ? `?${search}` : '',
				),
			}
		}
		const { bindings, request, user, loadDocumentHead, search } = await context(
			'/connect/oauth',
			data,
		)
		const payload = await loadConnectOauthLoaderData(
			bindings,
			request,
			data,
			user,
		)
		return {
			payload,
			head: loadDocumentHead(
				'connectOauth',
				'/connect/oauth',
				{ connectOauth: payload },
				search,
			),
		}
	})

const webhookApplyDecisionInput = z.object({
	handle: z.string().trim().min(1),
	fingerprint: z.string().trim().min(1),
})
export const approveWebhookApply = createServerFn({ method: 'POST' })
	.validator(webhookApplyDecisionInput)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { approveConnectWebhookApply } =
			await import('../../src/app/connect-webhook-apply-data.ts')
		return withWebsiteMutation({}, async ({ env, user }) =>
			approveConnectWebhookApply({ env, user, ...data }),
		)
	})
export const rejectWebhookApply = createServerFn({ method: 'POST' })
	.validator(webhookApplyDecisionInput)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { rejectConnectWebhookApply } =
			await import('../../src/app/connect-webhook-apply-data.ts')
		return withWebsiteMutation({}, async ({ env, user }) =>
			rejectConnectWebhookApply({ env, user, ...data }),
		)
	})
