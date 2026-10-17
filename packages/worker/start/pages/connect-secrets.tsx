/** @jsxImportSource @emotion/react */
import { connectSecretsInput } from '../connect-input.ts'
import {
	approveSecretAccess,
	rejectSecretAccess,
} from '#start/server/account-mutations'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { routes } from '#universal/routes.ts'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildHumanApprovalErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { type CSSObject } from '@emotion/react'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { connectSecretsQuery } from '../connect-approval-queries.ts'
import { SiteLink } from '../components/site-link.tsx'
import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'

import {
	type ApprovalAction,
	type ApprovalView,
	allowHostsButtonLabel,
	approvalRejectedHosts,
	approvalRequestedHosts,
} from '#client/routes/account-approval-shared.ts'

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

const connectSecretsPageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}

const connectSecretsHeaderCss: CSSObject = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

const connectSecretsPrimaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const connectSecretsSecondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

export function ConnectSecretsRoute({
	initialData,
}: {
	initialData: AccountSecretsLoaderData
}) {
	const invalidatePages = usePageInvalidation(mutationResources)
	const { pageLocation } = useMatchedPageScope()
	const href = pageLocation.pathname + pageLocation.searchStr
	const data = initialData
	const queryClient = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const [message, setMessage] = useState<string | null>(null)
	const [completed, setCompleted] = useState<ApprovalAction | null>(null)
	const capture = useSubmitterScope()
	const captureScope = () => ({
		queryKey: connectSecretsQuery(
			actorKey,
			connectSecretsInput(new URL(href, 'https://kody.local').search),
		).queryKey,
		invalidate: invalidatePages,
	})
	const reconcile = async (
		_result: unknown,
		_error: unknown,
		_input: unknown,
		scope: ReturnType<typeof captureScope> | undefined,
	) => {
		if (!scope) return
		await queryClient.cancelQueries({ queryKey: scope.queryKey, exact: true })
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: scope.queryKey, exact: true }),
			scope.invalidate(),
		])
	}
	const approve = useMutation({
		mutationFn: approveSecretAccess,
		onMutate: captureScope,
		onSettled: reconcile,
		gcTime: 0,
		retry: false,
	})
	const reject = useMutation({
		mutationFn: rejectSecretAccess,
		onMutate: captureScope,
		onSettled: reconcile,
		gcTime: 0,
		retry: false,
	})
	const submittingAction = approve.isPending
		? 'approve'
		: reject.isPending
			? 'reject'
			: null
	async function submitApproval(action: ApprovalAction) {
		if (submittingAction || !data.approval) return
		const isCurrent = capture()
		setMessage(null)
		try {
			const url = new URL(href, 'https://kody.local')
			const input = {
				data: {
					orgSlug: url.searchParams.get('org') ?? undefined,
					refresh: connectSecretsInput(url.search),
				},
			}
			if (action === 'approve') await approve.mutateAsync(input)
			else await reject.mutateAsync(input)
			if (isCurrent()) setCompleted(action)
		} catch (error) {
			if (isCurrent())
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to process approval.',
				)
		}
	}

	const approval = data?.approval ?? null
	const rejectedHosts = approval ? approvalRejectedHosts(approval) : []
	const alreadyAllowed =
		approval != null &&
		completed !== 'reject' &&
		isConnectSecretsAlreadyAllowed({
			secrets: data?.secrets ?? [],
			approval,
		})
	const hosts = approval ? approvalRequestedHosts(approval) : []
	const names = approval?.names.length ? approval.names : []
	const view = readConnectSecretsView({
		hostCount: hosts.length,
		rejectedCount: rejectedHosts.length,
		completed,
		alreadyAllowed,
	})
	const { onlyInvalid, fullyAllowed, leftoverInvalid, showBackToSecrets } = view

	return (
		<section css={connectSecretsPageCss} data-testid="connect-secrets">
			<header css={connectSecretsHeaderCss}>
				<span css={pageEyebrowCss}>Allow secret hosts</span>
				<h1 css={pageTitleCss}>
					{fullyAllowed
						? 'Access allowed'
						: leftoverInvalid
							? 'Some hosts could not be allowed'
							: onlyInvalid
								? 'These hosts are not valid'
								: completed === 'reject'
									? 'Request rejected'
									: 'Allow this secret at these hosts'}
				</h1>
				<p css={pageDescriptionCss}>
					{fullyAllowed
						? 'Kody can send this saved secret to the hosts below.'
						: leftoverInvalid
							? 'Valid hosts were allowed. Invalid hosts from this link were not written to the allowlist — copy the approval link again if it was truncated.'
							: onlyInvalid
								? 'Kody did not treat these values as hosts you can allow. Copy the approval link again if it was truncated.'
								: completed === 'reject'
									? 'No hosts were added. You can approve later from this same link.'
									: approval
										? 'Kody only sends a saved secret to hosts you approve. Saving a secret does not do this automatically.'
										: 'Open an approval link from Kody to allow a saved secret at a host.'}
				</p>
			</header>

			{data?.approvalError ? (
				<section
					css={{
						...cardCss,
						border: `1px solid ${colors.danger}`,
					}}
					data-testid="connect-secrets-error"
				>
					<p css={{ margin: 0, color: colors.danger }}>{data.approvalError}</p>
					<ErrorAgentPromptButton
						prompt={buildHumanApprovalErrorAgentPrompt({
							activity:
								'Allowing secret hosts from a /connect/secrets approval link.',
							errorMessage: data.approvalError,
							ids: { path: '/connect/secrets' },
						})}
					/>
				</section>
			) : null}

			{message ? (
				<>
					<p css={{ margin: 0, color: colors.danger }}>{message}</p>
					{data?.approvalError ? null : (
						<ErrorAgentPromptButton
							prompt={buildHumanApprovalErrorAgentPrompt({
								activity:
									'Allowing secret hosts from a /connect/secrets approval link.',
								errorMessage: message,
								ids: { path: '/connect/secrets' },
							})}
						/>
					)}
				</>
			) : null}

			{approval && (hosts.length > 0 || rejectedHosts.length > 0) ? (
				<section css={cardCss} data-testid="connect-secrets-card">
					<div css={{ display: 'grid', gap: spacing.sm }}>
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<span css={{ color: colors.textMuted }}>
								{names.length === 1 ? 'Secret' : 'Secrets'}
							</span>
							<ul
								css={{
									margin: 0,
									paddingLeft: spacing.lg,
									display: 'grid',
									gap: spacing.xs,
								}}
							>
								{names.map((name) => (
									<li key={name}>
										<code>{name}</code>
									</li>
								))}
							</ul>
						</div>
						{hosts.length > 0 ? (
							<div css={{ display: 'grid', gap: spacing.xs }}>
								<span css={{ color: colors.textMuted }}>
									{hosts.length === 1 ? 'Host' : 'Hosts'}
								</span>
								<ul
									css={{
										margin: 0,
										paddingLeft: spacing.lg,
										display: 'grid',
										gap: spacing.xs,
									}}
								>
									{hosts.map((host) => (
										<li key={host}>
											<strong css={{ color: colors.text }}>{host}</strong>
										</li>
									))}
								</ul>
							</div>
						) : null}
						{rejectedHosts.length > 0 ? (
							<div
								css={getAccentCalloutCss({ accentColor: colors.danger })}
								data-testid="connect-secrets-rejected-hosts"
							>
								<span css={{ color: colors.danger, fontWeight: 600 }}>
									{rejectedHosts.length === 1
										? 'This host is not valid'
										: `${rejectedHosts.length} hosts are not valid`}
								</span>
								<ul
									css={{
										margin: 0,
										paddingLeft: spacing.lg,
										display: 'grid',
										gap: spacing.xs,
									}}
								>
									{rejectedHosts.map((entry) => (
										<li key={entry.host}>
											<strong css={{ color: colors.text }}>{entry.host}</strong>
											<span css={{ color: colors.textMuted }}>
												{' '}
												— {entry.message}
											</span>
										</li>
									))}
								</ul>
							</div>
						) : null}
					</div>
					{showBackToSecrets ? (
						<SiteLink
							href={routes.accountCredentials.href()}
							css={connectSecretsSecondaryButtonCss}
						>
							Back to credentials
						</SiteLink>
					) : (
						<div
							css={{
								display: 'flex',
								gap: spacing.sm,
								flexWrap: 'wrap',
							}}
						>
							{hosts.length > 0 && completed !== 'approve' ? (
								<button
									type="button"
									disabled={submittingAction != null}
									onClick={() => {
										void submitApproval('approve')
									}}
									css={connectSecretsPrimaryButtonCss}
								>
									{submittingAction === 'approve'
										? 'Allowing access…'
										: allowHostsButtonLabel(hosts.length, rejectedHosts.length)}
								</button>
							) : null}
							<button
								type="button"
								disabled={submittingAction != null}
								onClick={() => {
									void submitApproval('reject')
								}}
								css={connectSecretsSecondaryButtonCss}
							>
								Reject
							</button>
						</div>
					)}
				</section>
			) : null}
		</section>
	)
}

export function readConnectSecretsView(input: {
	hostCount: number
	rejectedCount: number
	completed: ApprovalAction | null
	alreadyAllowed: boolean
}) {
	const onlyInvalid =
		input.hostCount === 0 &&
		input.rejectedCount > 0 &&
		input.completed !== 'reject'
	const fullyAllowed =
		(input.completed === 'approve' || input.alreadyAllowed) &&
		input.rejectedCount === 0 &&
		!onlyInvalid
	const leftoverInvalid =
		input.rejectedCount > 0 &&
		(input.completed === 'approve' || input.alreadyAllowed)
	return {
		onlyInvalid,
		fullyAllowed,
		leftoverInvalid,
		showBackToSecrets:
			fullyAllowed ||
			leftoverInvalid ||
			input.alreadyAllowed ||
			input.completed === 'reject',
	}
}

export function isConnectSecretsAlreadyAllowed(input: {
	secrets: AccountSecretsLoaderData['secrets']
	approval: ApprovalView
}) {
	if (approvalRequestedHosts(input.approval).length === 0) return false
	const pendingPairs = collectPendingHostPairs(input.secrets, input.approval)
	if (pendingPairs.length > 0) return false
	return input.approval.names.every((name) =>
		input.secrets.some(
			(item) => item.name === name && item.scope === input.approval.scope,
		),
	)
}

function collectPendingHostPairs(
	secrets: AccountSecretsLoaderData['secrets'],
	approval: ApprovalView,
) {
	const hosts = approvalRequestedHosts(approval)
	const pairs: Array<{ name: string; host: string }> = []
	for (const name of approval.names) {
		const secret = secrets.find(
			(item) => item.name === name && item.scope === approval.scope,
		)
		if (!secret) continue
		for (const host of hosts) {
			if (!secret.allowedHosts.includes(host)) {
				pairs.push({ name, host })
			}
		}
	}
	return pairs
}

const mutationResources = [
	'loadSecretsPage',
	'loadOnboarding',
	'loadAccountPage',
] as const
