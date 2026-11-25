/** @jsxImportSource @emotion/react */
import { TextLink } from '../components/text-link.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { createUiFeedback, type UiFeedback } from '#client/ui-feedback.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { packageWebhookMutationOptions } from '../package-webhook-mutation.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { useRef, useState } from 'react'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { isNotFound, useRouteContext } from '@tanstack/react-router'
import { packageWebhooksQuery } from '../package-webhooks-query.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import type { PackageWebhookListItem } from '#universal/loader-data.ts'
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
import {
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'
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
	const loaded = read.data?.ok ? read.data : null
	const webhooks = loaded?.webhooks ?? []
	const loadError = read.isError
		? isNotFound(read.error)
			? 'Package not found.'
			: read.error.message || 'Unable to load webhooks.'
		: read.data && !read.data.ok
			? read.data.error
			: null
	const status = loadError ? 'error' : loaded ? 'ready' : 'loading'
	const [feedback, setFeedback] = useState<UiFeedback | null>(() =>
		createUiFeedback(null, 'info'),
	)
	const message = feedback?.message ?? null
	const messageTone = feedback?.tone ?? 'info'

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
		setFeedback(createUiFeedback(null))
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
			setFeedback(createUiFeedback(webhookSuccessMessage(intent), 'info'))
		} catch (error) {
			if (!isCurrent()) return
			setFeedback(
				createUiFeedback(
					error instanceof Error
						? error.message
						: webhookFailureMessage(intent),
					'error',
				),
			)
		}
	}
	function confirmation(webhook: PackageWebhookListItem, intent: 'rotate') {
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
	const mutedCss = { margin: 0, color: colors.textMuted }
	return (
		<AccountManagementPanel
			id={packageWebhooksSectionId}
			headingId="package-webhooks-title"
			testId="package-webhook-settings"
			busy={status === 'loading' || mutating}
			title="Webhooks"
			description={
				<>
					Inbound webhook URLs this package declares in{' '}
					<code>package.json#kody.webhooks</code>. Mint a URL here, copy it into
					the provider that will POST to it, and rotate it if it leaks. Turn it
					off from Triggers when it goes unused. Rotate keeps the previous URL
					live for a short overlap so providers can finish switching. Agents
					connected over MCP can mint and apply handles but never see these
					URLs.
				</>
			}
		>
			{status === 'loading' ? (
				<LoadingIndicator label="Loading webhooks…" />
			) : null}
			{loadError ? (
				<AccountManagementMessage tone="error">
					{loadError}
				</AccountManagementMessage>
			) : null}

			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}
			{status === 'ready' && !webhooks.length ? (
				<p css={mutedCss} data-testid="package-webhook-settings-empty">
					This package declares no webhooks yet. Add a{' '}
					<code>kody.webhooks</code> entry to its <code>package.json</code> and
					publish it.{' '}
					<TextLink tone="prose" href={webhooksDocHref}>
						Inbound webhooks docs
					</TextLink>
				</p>
			) : null}
			{status === 'ready' && webhooks.length ? (
				<>
					<p css={mutedCss} data-testid="package-webhook-settings-count">
						{webhookDeclaredCount(webhooks)} declared ·{' '}
						{webhooks.filter((x) => x.minted).length} minted
					</p>
					<div css={{ display: 'grid', gap: spacing.md }}>
						{webhooks.map((webhook) => (
							<div key={webhook.id}>
								{
									<PackageWebhookCard
										deliveriesHref={`${orgResourcePath(username, 'activity')}?view=recent&status=all&surface=webhook`}
										{...{
											webhook,
											username,
											kodyId,
											revealedUrl: revealedUrls.get(webhook.id) ?? null,
											isMutating: mutating,
											rotateCheck: confirmation(webhook, 'rotate'),
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
		</AccountManagementPanel>
	)
}

const mutationResources = ['loadPackage', 'loadWebhooksPage'] as const
