/** @jsxImportSource @emotion/react */
import { connectWebhookInput } from '../connect-input.ts'
import { approveWebhookApply, rejectWebhookApply } from '#start/server/connect'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildHumanApprovalErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { type CSSObject } from '@emotion/react'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { connectWebhookApplyQuery } from '../connect-approval-queries.ts'

import { type ConnectWebhookApplyLoaderData } from '#universal/loader-data.ts'

import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	getAccentCalloutCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

const pageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '36rem',
	margin: '0 auto',
}

const headerCss: CSSObject = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const metaListCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	margin: 0,
	padding: 0,
	listStyle: 'none',
	fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
	fontSize: '0.85rem',
	color: colors.textMuted,
	overflowWrap: 'anywhere' as const,
}

export function ConnectWebhookApplyRoute({
	initialData,
}: {
	initialData: ConnectWebhookApplyLoaderData
}) {
	const invalidatePages = usePageInvalidation(mutationResources)
	const { pageLocation } = useMatchedPageScope()
	const href = pageLocation.pathname + pageLocation.searchStr
	const data = initialData
	const [message, setMessage] = useState<string | null>(null)
	const queryClient = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const mutation = useMutation({
		mutationKey: ['connectWebhookApply', actorKey],
		mutationFn: async ({
			action,
			href,
		}: {
			action: 'approve' | 'reject'
			href: string
			invalidate: typeof invalidatePages
			queryKey: ReturnType<typeof connectWebhookApplyQuery>['queryKey']
		}) => {
			const search = new URL(href, 'https://kody.local').searchParams
			return (action === 'approve' ? approveWebhookApply : rejectWebhookApply)({
				data: {
					handle: search.get('handle') ?? '',
					fingerprint: search.get('fingerprint') ?? '',
				},
			})
		},
		onSuccess: async (payload, input) => {
			await queryClient.cancelQueries({
				queryKey: input.queryKey,
				exact: true,
			})
			queryClient.setQueryData(input.queryKey, (previous) =>
				previous ? { ...previous, payload } : previous,
			)
			void input.invalidate()
		},
	})
	const submitting = mutation.isPending ? mutation.variables.action : null
	async function submit(action: 'approve' | 'reject') {
		if (mutation.isPending || !data.ok) return
		setMessage(null)
		try {
			const payload = await mutation.mutateAsync({
				action,
				href,
				invalidate: invalidatePages,
				queryKey: connectWebhookApplyQuery(
					actorKey,
					connectWebhookInput(new URL(href, 'https://kody.local').search),
				).queryKey,
			})
			setMessage(
				action === 'approve' && payload.ok
					? 'Destination approved. Return to your agent and retry webhookUrlApply.'
					: payload.ok
						? null
						: payload.error,
			)
		} catch (error) {
			setMessage(
				error instanceof Error ? error.message : 'Unable to process approval.',
			)
		}
	}

	const payload = data

	return (
		<section css={pageCss} data-testid="connect-webhook-apply">
			<header css={headerCss}>
				<p css={pageEyebrowCss}>Webhook apply approval</p>
				<h1 css={pageTitleCss}>Approve outbound destination</h1>
				<p css={pageDescriptionCss}>
					Same account approval flow as secret host approval
					(`/connect/secrets`), secret package grants, and locked-package
					publish approval. Allow only if you trust this exact registration
					request.
				</p>
			</header>

			{message ? (
				<>
					<p
						css={getAccentCalloutCss()}
						data-testid="connect-webhook-apply-message"
					>
						{message}
					</p>
					{payload?.ok !== false &&
					!(payload?.ok && message.includes('Destination approved')) ? (
						<ErrorAgentPromptButton
							prompt={buildHumanApprovalErrorAgentPrompt({
								activity:
									'Approving an outbound webhook destination in the browser.',
								errorMessage: message,
								ids: {
									packageName:
										payload && payload.ok ? payload.packageName : null,
									packageKodyId:
										payload && payload.ok ? payload.packageKodyId : null,
									path: '/connect/webhook-apply',
								},
							})}
						/>
					) : null}
				</>
			) : null}

			{!payload ? (
				<p css={{ color: colors.textMuted, textAlign: 'center' }}>
					Loading approval…
				</p>
			) : !payload.ok ? (
				<section css={cardCss} data-testid="connect-webhook-apply-error">
					<p css={{ margin: 0 }}>{payload.error}</p>
					<ErrorAgentPromptButton
						prompt={buildHumanApprovalErrorAgentPrompt({
							activity:
								'Approving an outbound webhook destination in the browser.',
							errorMessage: payload.error,
							ids: { path: '/connect/webhook-apply' },
						})}
					/>
				</section>
			) : (
				<section css={cardCss} data-testid="connect-webhook-apply-card">
					<p css={{ marginTop: 0 }}>
						Package <strong>{payload.packageName}</strong> (
						<code>{payload.packageKodyId}</code>) wants to register webhook{' '}
						<code>{payload.webhookName}</code> at this destination.
					</p>
					<ul css={metaListCss}>
						<li>method: {payload.destination.method}</li>
						<li>url: {payload.destination.url}</li>
						<li>
							injection sites:{' '}
							{payload.destination.injectionSites.join(', ') || '(none)'}
						</li>
						<li>
							headers:{' '}
							{payload.destination.headers.length > 0
								? payload.destination.headers
										.map((header) => `${header.name}=${header.value}`)
										.join('; ')
								: '(none)'}
						</li>
						<li>
							body:{' '}
							{payload.destination.body.length > 0
								? payload.destination.body
								: '(none)'}
						</li>
						<li>auth: {payload.destination.auth}</li>
						<li>fingerprint: {payload.fingerprint}</li>
					</ul>
					{payload.alreadyGranted ? (
						<p css={{ marginBottom: 0 }}>
							This exact destination is already approved. Ask your agent to
							retry <code>webhookUrlApply</code>.
						</p>
					) : (
						<div
							css={{
								display: 'flex',
								gap: spacing.sm,
								flexWrap: 'wrap',
								marginTop: spacing.md,
							}}
						>
							<button
								type="button"
								disabled={submitting != null}
								data-testid="connect-webhook-apply-allow"
								onClick={() => {
									void submit('approve')
								}}
								css={primaryButtonCss}
							>
								{submitting === 'approve' ? 'Approving…' : 'Allow destination'}
							</button>
							<button
								type="button"
								disabled={submitting != null}
								data-testid="connect-webhook-apply-reject"
								onClick={() => {
									void submit('reject')
								}}
								css={secondaryButtonCss}
							>
								{submitting === 'reject' ? 'Rejecting…' : 'Reject'}
							</button>
						</div>
					)}
				</section>
			)}
		</section>
	)
}

const mutationResources = ['loadWebhooksPage', 'loadPackage'] as const
