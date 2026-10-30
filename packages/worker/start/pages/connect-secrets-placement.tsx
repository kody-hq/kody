/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { approveSecretAccess } from '#start/server/account-mutations'
import { approveCredentialPlacementRequest } from '#start/server/credential-placement'
import { connectSecretsInput } from '../connect-input.ts'
import { connectSecretsQuery } from '../connect-approval-queries.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { SiteLink } from '../components/site-link.tsx'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildHumanApprovalErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { routes } from '#universal/routes.ts'
import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { formatFillPlacementSummary } from '#universal/credential-fill-placement.ts'
import {
	type CredentialPlacementApprovalView,
	formatPlacementApprovalParts,
	type PlacementApprovalPart,
} from '#universal/credential-placement-approval.ts'
import {
	approvalRejectedHosts,
	approvalRequestedHosts,
} from '#client/routes/account-approval-shared.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
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
	maxWidth: '32rem',
	margin: '0 auto',
}

const headerCss: CSSObject = {
	...pageHeaderCss,
	justifyItems: 'center',
	textAlign: 'center' as const,
}

const primaryButtonCss = getPrimaryButtonCss({ size: 'lg', weight: 'semibold' })
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})

const sectionCss: CSSObject = { display: 'grid', gap: spacing.xs }
const labelCss: CSSObject = { color: colors.textMuted }
const listCss: CSSObject = {
	margin: 0,
	paddingLeft: spacing.lg,
	display: 'grid',
	gap: spacing.xs,
}
const rowCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'baseline',
	columnGap: spacing.sm,
	rowGap: '0.15rem',
}
const statusCss: CSSObject = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
const summaryCss: CSSObject = {
	fontFamily: 'monospace',
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
}
const warningCss: CSSObject = {
	display: 'grid',
	gap: '0.35rem',
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.warning}`,
	background: `color-mix(in srgb, ${colors.warning} 10%, transparent)`,
	color: colors.warningText,
}

type Step = 'approve' | 'reject'

const mutationResources = [
	'loadSecretsPage',
	'loadOnboarding',
	'loadAccountPage',
] as const

function pendingHostsOf(data: AccountSecretsLoaderData) {
	const approval = data.approval
	if (!approval) return []
	const hosts = approvalRequestedHosts(approval)
	const named = approval.names.length > 0 ? approval.names : [approval.name]
	return hosts.filter((host) =>
		named.some((name) => {
			const secret = data.secrets.find(
				(item) => item.name === name && item.scope === approval.scope,
			)
			return secret != null && !secret.allowedHosts.includes(host)
		}),
	)
}

function pendingPartsOf(view: CredentialPlacementApprovalView) {
	const pending = new Set<PlacementApprovalPart>()
	for (const credential of view.credentials) {
		for (const part of credential.pendingParts) pending.add(part)
	}
	return view.parts.filter((part) => pending.has(part))
}

/**
 * `/connect/secrets?placement=`: the owner allows a credential to be filled
 * into the query, URL path, or body (and any requested hosts) in one click.
 */
export function ConnectSecretsPlacementApproval({
	data,
	href,
}: {
	data: AccountSecretsLoaderData
	href: string
}) {
	const invalidatePages = usePageInvalidation(mutationResources)
	const queryClient = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const [message, setMessage] = useState<string | null>(null)
	const [completed, setCompleted] = useState<Step | null>(null)
	const view = data.placementApproval ?? null
	const url = new URL(href, 'https://kody.local')
	const orgSlug = url.searchParams.get('org') ?? undefined
	const refresh = async () => {
		const queryKey = connectSecretsQuery(
			actorKey,
			connectSecretsInput(url.search),
		).queryKey
		await queryClient.cancelQueries({ queryKey, exact: true })
		await Promise.all([
			queryClient.invalidateQueries({ queryKey, exact: true }),
			invalidatePages(),
		])
	}
	const approveHosts = useMutation({
		mutationFn: approveSecretAccess,
		gcTime: 0,
		retry: false,
	})
	const approvePlacement = useMutation({
		mutationFn: approveCredentialPlacementRequest,
		gcTime: 0,
		retry: false,
	})
	const submitting = approveHosts.isPending || approvePlacement.isPending

	const parts = view?.parts ?? []
	const partsLabel = formatPlacementApprovalParts(parts)
	const pendingParts = view ? pendingPartsOf(view) : []
	const pendingHosts = pendingHostsOf(data)
	const requestedHosts = data.approval
		? approvalRequestedHosts(data.approval)
		: []
	const rejectedHosts = data.approval
		? approvalRejectedHosts(data.approval)
		: []
	const credentials = view?.credentials ?? []
	const missingNames = view?.missingNames ?? []
	const nothingPending =
		credentials.length > 0 &&
		pendingParts.length === 0 &&
		pendingHosts.length === 0
	const done =
		(completed === 'approve' || nothingPending) &&
		missingNames.length === 0 &&
		rejectedHosts.length === 0 &&
		!data.approvalError
	const partlyDone =
		!done &&
		(completed === 'approve' || nothingPending) &&
		(missingNames.length > 0 ||
			rejectedHosts.length > 0 ||
			Boolean(data.approvalError))
	const error = data.placementApprovalError ?? data.approvalError ?? null
	const canApprove =
		!done &&
		completed !== 'reject' &&
		credentials.length > 0 &&
		(pendingParts.length > 0 || pendingHosts.length > 0)
	const single = credentials.length === 1 ? credentials[0] : null

	async function approve() {
		if (submitting || !view) return
		const isCurrent = capture()
		setMessage(null)
		try {
			// Placement first: it needs Write on each credential, so a refusal
			// stops before any host is allowed.
			const names = credentials
				.filter((credential) => credential.pendingParts.length > 0)
				.map((credential) => credential.name)
			if (names.length > 0) {
				await approvePlacement.mutateAsync({
					data: {
						orgSlug,
						names,
						parts: view.parts,
						credentialId: connectSecretsInput(url.search).placementCredentialId,
					},
				})
			}
			if (pendingHosts.length > 0) {
				await approveHosts.mutateAsync({
					data: { orgSlug, refresh: connectSecretsInput(url.search) },
				})
			}
			if (isCurrent()) setCompleted('approve')
		} catch (caught) {
			if (isCurrent())
				setMessage(
					caught instanceof Error
						? caught.message
						: 'Unable to approve this request.',
				)
		} finally {
			await refresh()
		}
	}

	const title = done
		? 'Placement allowed'
		: partlyDone
			? 'Some of this request could not be allowed'
			: completed === 'reject'
				? 'Request declined'
				: single
					? `Allow ${single.name} in the request ${partsLabel}`
					: credentials.length > 1
						? `Allow these credentials in the request ${partsLabel}`
						: 'Allow credential placement'
	const description = partlyDone
		? 'Everything valid was allowed. Credentials that are not saved and hosts that are not valid were left out; fix those, then open the approval link again.'
		: done
			? `Kody can fill ${single ? single.name : 'these credentials'} into the request ${partsLabel} on requests to ${single ? 'its' : 'their'} allowed hosts.`
			: completed === 'reject'
				? 'Nothing changed. You can approve later from this same link.'
				: credentials.length > 0
					? `An agent asked to let Kody fill ${single ? 'this credential' : 'these credentials'} into the request ${partsLabel}. Kody keeps headers only until you approve here.`
					: 'Open a placement approval link from Kody to allow a credential in the query, URL path, or body.'

	return (
		<section css={pageCss} data-testid="connect-secrets-placement">
			<header css={headerCss}>
				<span css={pageEyebrowCss}>Credential placement</span>
				<h1 css={{ ...pageTitleCss, overflowWrap: 'anywhere' }}>{title}</h1>
				<p css={pageDescriptionCss}>{description}</p>
			</header>

			{error || message ? (
				<section
					css={{ ...cardCss, border: `1px solid ${colors.danger}` }}
					data-testid="connect-secrets-placement-error"
				>
					<p css={{ margin: 0, color: colors.danger }}>{message ?? error}</p>
					<ErrorAgentPromptButton
						prompt={buildHumanApprovalErrorAgentPrompt({
							activity:
								'Allowing a credential placement from a /connect/secrets approval link.',
							errorMessage: message ?? error ?? '',
							ids: { path: '/connect/secrets' },
						})}
					/>
				</section>
			) : null}

			{view && (credentials.length > 0 || missingNames.length > 0) ? (
				<section css={cardCss} data-testid="connect-secrets-placement-card">
					<div css={{ display: 'grid', gap: spacing.md }}>
						{credentials.length > 0 ? (
							<div css={sectionCss}>
								<span css={labelCss}>
									{credentials.length === 1 ? 'Credential' : 'Credentials'}
								</span>
								<ul css={listCss}>
									{credentials.map((credential) => (
										<li key={credential.name}>
											<div css={rowCss}>
												<code css={{ overflowWrap: 'anywhere' }}>
													{credential.name}
												</code>
											</div>
											<div css={statusCss}>
												{credential.pendingParts.length === 0 || done ? (
													<>
														Fills{' '}
														<span css={summaryCss}>
															{formatFillPlacementSummary(
																done && credential.placementAfter
																	? credential.placementAfter
																	: credential.placement,
															)}
														</span>
													</>
												) : (
													<>
														Now{' '}
														<span css={summaryCss}>
															{formatFillPlacementSummary(credential.placement)}
														</span>
														{' → after approval '}
														<span css={summaryCss}>
															{formatFillPlacementSummary(
																credential.placementAfter,
															)}
														</span>
													</>
												)}
											</div>
										</li>
									))}
								</ul>
							</div>
						) : null}

						<div css={sectionCss}>
							<span css={labelCss}>Request part</span>
							<ul css={listCss}>
								{parts.map((part) => (
									<li key={part}>
										<strong css={{ color: colors.text }}>
											{formatPlacementApprovalParts([part])}
										</strong>
									</li>
								))}
							</ul>
						</div>

						{requestedHosts.length > 0 ? (
							<div css={sectionCss}>
								<span css={labelCss}>
									{requestedHosts.length === 1 ? 'Host' : 'Hosts'}
								</span>
								<ul css={listCss}>
									{requestedHosts.map((host) => (
										<li key={host}>
											<div css={rowCss}>
												<strong
													css={{ color: colors.text, overflowWrap: 'anywhere' }}
												>
													{host}
												</strong>
												<span css={statusCss}>
													{pendingHosts.includes(host) && !done
														? 'Will be allowed'
														: 'Allowed'}
												</span>
											</div>
										</li>
									))}
								</ul>
							</div>
						) : null}

						{rejectedHosts.length > 0 ? (
							<div
								css={getAccentCalloutCss({ accentColor: colors.danger })}
								data-testid="connect-secrets-placement-rejected-hosts"
							>
								<span css={{ color: colors.danger, fontWeight: 600 }}>
									{rejectedHosts.length === 1
										? 'This host is not valid'
										: `${rejectedHosts.length} hosts are not valid`}
								</span>
								<ul css={listCss}>
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

						{missingNames.length > 0 ? (
							<div
								css={getAccentCalloutCss({ accentColor: colors.danger })}
								data-testid="connect-secrets-placement-missing"
							>
								<span css={{ color: colors.danger, fontWeight: 600 }}>
									{missingNames.length === 1
										? 'No saved credential with this name'
										: 'No saved credentials with these names'}
								</span>
								<ul css={listCss}>
									{missingNames.map((name) => (
										<li key={name}>
											<code>{name}</code>
										</li>
									))}
								</ul>
								<span css={{ color: colors.textMuted }}>
									Save the credential first, then open this link again.
								</span>
							</div>
						) : null}

						{canApprove &&
						(pendingParts.length > 0 || pendingHosts.length > 0) ? (
							<div
								css={warningCss}
								role="note"
								data-testid="connect-secrets-placement-warning"
							>
								<strong>The host may store this value</strong>
								<span>
									A value sent in the query, URL path, or body can end up in the
									host&apos;s access logs or saved records. Allow it only when
									the host needs the credential there. Approving is your opt-in
									for this credential; agents can&apos;t approve it for you.
								</span>
							</div>
						) : null}
					</div>

					{canApprove ? (
						<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
							<button
								type="button"
								disabled={submitting}
								onClick={() => {
									void approve()
								}}
								css={primaryButtonCss}
								data-testid="connect-secrets-placement-approve"
							>
								{submitting
									? 'Allowing…'
									: approveLabel({
											parts: pendingParts,
											hostCount: pendingHosts.length,
										})}
							</button>
							<button
								type="button"
								disabled={submitting}
								onClick={() => {
									setMessage(null)
									setCompleted('reject')
								}}
								css={secondaryButtonCss}
							>
								Decline
							</button>
						</div>
					) : (
						<SiteLink
							href={routes.accountCredentials.href()}
							css={secondaryButtonCss}
						>
							Back to credentials
						</SiteLink>
					)}
				</section>
			) : null}
		</section>
	)
}

function approveLabel(input: {
	parts: ReadonlyArray<PlacementApprovalPart>
	hostCount: number
}) {
	const parts = formatPlacementApprovalParts(input.parts)
	if (input.hostCount === 0) return `Allow ${parts}`
	if (input.parts.length === 0)
		return input.hostCount === 1
			? 'Allow host'
			: `Allow ${input.hostCount} hosts`
	return input.hostCount === 1
		? `Allow host and ${parts}`
		: `Allow ${input.hostCount} hosts and ${parts}`
}
