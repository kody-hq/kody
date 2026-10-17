/** @jsxImportSource @emotion/react */
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { packageWebhookMutationOptions } from '../package-webhook-mutation.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { useRef, useState } from 'react'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { packageWebhooksQuery } from '../package-webhooks-query.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { type PackageWebhookListItem } from '#universal/loader-data.ts'
import {
	webhookFailureMessage,
	webhookSuccessMessage,
	webhookDeclaredCount,
	packageWebhooksSectionId,
	webhooksDocHref,
} from '#client/routes/webhooks-shared.ts'
import {
	type PackageWebhookCardIntent,
	renderPackageWebhookCard as PackageWebhookCard,
} from './package-webhook-card.tsx'
import { AccountManagementMessage } from './account-management-components.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { detailSectionCss } from '../components/community-detail-sections.tsx'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
export function PackageWebhookSettings({
	username,
	kodyId,
}: {
	username: string
	kodyId: string
}) {
	const capture = useSubmitterScope()
	const submissionId = useRef(0)
	const invalidatePages = usePageInvalidation(mutationResources)
	const queryClient = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const query = packageWebhooksQuery(actorKey, { username, kodyId })
	const read = useQuery({ ...query, retry: false, retryOnMount: false })
	const webhooks = read.data?.webhooks ?? []
	const status = read.isError ? 'error' : read.data ? 'ready' : 'loading'
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const [revealedUrls, setRevealedUrls] = useState<Map<string, string>>(
		new Map(),
	)
	const [confirmed, setConfirmed] = useState<string | null>(null)
	const mutation = useMutation({
		mutationKey: ['packageWebhooks', actorKey, username, kodyId],
		...packageWebhookMutationOptions(queryClient),
	})
	const mutating = mutation.isPending
	async function runIntent(
		webhook: PackageWebhookListItem,
		payload: PackageWebhookCardIntent,
	) {
		const { intent } = payload
		if (mutating) return
		const currentSubmission = ++submissionId.current
		const isCurrent = capture()
		setMessage(null)
		try {
			const accepted = await mutation.mutateAsync({
				username,
				kodyId,
				webhookName: webhook.name,
				endpointId: webhook.endpointId,
				createInstance: payload.createInstance,
				instanceLabel: payload.instanceLabel,
				webhookId: webhook.id,
				intent,
				queryKey: query.queryKey,
				invalidate: invalidatePages,
			})
			if (submissionId.current === currentSubmission) mutation.reset()
			if (!isCurrent()) return
			setConfirmed(null)
			setRevealedUrls((previous) => {
				const next = new Map(previous)
				if (intent === 'rotate') next.delete(webhook.id)
				if (accepted.revealed)
					next.set(accepted.revealed.id, accepted.revealed.url)
				return next
			})
			setMessage(webhookSuccessMessage(intent))
			setMessageTone('info')
		} catch (error) {
			if (!isCurrent()) return
			setMessage(
				error instanceof Error ? error.message : webhookFailureMessage(intent),
			)
			setMessageTone('error')
		}
	}
	function confirmation(
		webhook: PackageWebhookListItem,
		intent: 'rotate' | 'disable',
	) {
		const key = `${webhook.id}:${intent}`
		return {
			armed: confirmed === key,
			onBlur: () => setConfirmed(null),
			onClick: () => {
				if (confirmed === key) void runIntent(webhook, { intent })
				else setConfirmed(key)
			},
		}
	}
	const mutedCss = { margin: `${spacing.md} 0 0`, color: colors.textMuted }
	return (
		<section
			id={packageWebhooksSectionId}
			aria-labelledby="package-webhooks-title"
			aria-busy={status === 'loading' || mutating}
			data-testid="package-webhook-settings"
			css={{ ...detailSectionCss, scrollMarginTop: spacing.xl }}
		>
			<h2 id="package-webhooks-title">Webhooks</h2>
			<p>
				Inbound webhook URLs this package declares in{' '}
				<code>package.json#kody.webhooks</code>. Mint a URL here, copy it into
				the provider that will POST to it, and rotate or disable it when it
				leaks or goes unused. Rotate keeps the previous URL live for a short
				overlap so providers can finish switching. Agents connected over MCP can
				mint and apply handles but never see these URLs.
			</p>

			{status === 'loading' ? (
				<p role="status" css={mutedCss}>
					Loading webhooks…
				</p>
			) : null}
			{read.isError ? (
				<AccountManagementMessage tone="error">
					Unable to load webhooks.
				</AccountManagementMessage>
			) : null}

			{message ? (
				<div css={{ marginTop: spacing.md }}>
					<AccountManagementMessage tone={messageTone}>
						{message}
					</AccountManagementMessage>
				</div>
			) : null}
			{status === 'ready' && !webhooks.length ? (
				<p css={mutedCss} data-testid="package-webhook-settings-empty">
					This package declares no webhooks yet. Add a{' '}
					<code>kody.webhooks</code> entry to its <code>package.json</code> and
					publish it.{' '}
					<SiteLink href={webhooksDocHref} css={primaryLinkCss}>
						Inbound webhooks docs
					</SiteLink>
				</p>
			) : null}
			{status === 'ready' && webhooks.length ? (
				<>
					<p css={mutedCss} data-testid="package-webhook-settings-count">
						{webhookDeclaredCount(webhooks)} declared ·{' '}
						{webhooks.filter((x) => x.minted).length} minted
					</p>
					<div
						css={{ display: 'grid', gap: spacing.md, marginTop: spacing.lg }}
					>
						{webhooks.map((webhook) => (
							<div key={webhook.id}>
								{
									<PackageWebhookCard
										deliveriesHref={`${orgResourcePath(username, 'activity')}?view=recent&status=all&surface=webhook`}
										{...{
											webhook,
											revealedUrl: revealedUrls.get(webhook.id) ?? null,
											isMutating: mutating,
											rotateCheck: confirmation(webhook, 'rotate'),
											disableCheck: confirmation(webhook, 'disable'),
											onIntent: (payload) => void runIntent(webhook, payload),
											showMintAnother:
												webhook.minted &&
												webhooks.find(
													(item) => item.name === webhook.name && item.minted,
												)?.id === webhook.id,
											onHideUrl: () =>
												setRevealedUrls((previous) => {
													const next = new Map(previous)
													next.delete(webhook.id)
													return next
												}),
										}}
									/>
								}
							</div>
						))}
					</div>
				</>
			) : null}
		</section>
	)
}

const mutationResources = ['loadPackage', 'loadWebhooksPage'] as const
