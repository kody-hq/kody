/** @jsxImportSource @emotion/react */
import { useParams } from '@tanstack/react-router'
import {
	parseCredentialApprovalQuery,
	readCredentialProposalId,
} from '#universal/credential-contracts.ts'
import { approvePackageCredentials } from '#start/server/credential-approval-mutation'
import { SiteLink } from '../components/site-link.tsx'

import { type ReactNode, useState } from 'react'
import { useCredentialMutation } from '../credential-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { NotFoundPage } from '../components/not-found-page.tsx'
import {
	type CredentialApprovalChangeView,
	type CredentialApprovalEnableView,
	type CredentialApprovalView,
	type CredentialProposalSender,
} from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import {
	type CredentialApprovalGroup,
	type PackageCredentialApprovalLoaderData,
	approvalAfterLabel,
	approvalBeforeLabel,
	approvalChangeIsNoop,
	approvalDoneCopy,
	approvalEnableStatus,
	approvalProblems,
	approvalSummary,
	credentialApprovalAgentPrompt,
	groupApprovalChanges,
} from '#universal/package-credential-approval-page.ts'
import { describeTrigger } from '#universal/package-credentials-page.ts'
import { routes } from '#universal/routes.ts'
import {
	cardCss,
	cardTitleCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
const primaryButtonCss = getPrimaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const mutedCss = { margin: 0, color: colors.textMuted }
const listCss = {
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.sm,
}
type ApprovalPath = {
	username: string
	kodyId: string
	search: string
}
function needSummary(change: CredentialApprovalChangeView) {
	if (!change.need) return null
	const parts = [
		change.need.kind ? credentialKindLabel(change.need.kind) : 'Any kind',
		change.need.provider,
	]
	if (change.need.multiple) parts.push('several allowed')
	return parts.join(' · ')
}
function renderChange(
	change: CredentialApprovalChangeView,
	index: number,
	approved: boolean,
) {
	const noop = !approved && approvalChangeIsNoop(change)
	return (
		<li
			key={index}
			data-testid={`approval-change-${index}`}
			css={{
				...insetCardCss,
				display: 'grid',
				gap: spacing.xs,
				borderLeft: change.error ? `4px solid ${colors.danger}` : undefined,
			}}
		>
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'baseline',
				}}
			>
				<strong>{change.needKey}</strong>
				{needSummary(change) ? (
					<span css={{ ...mutedCss, fontSize: typography.fontSize.sm }}>
						{needSummary(change)}
					</span>
				) : null}
			</div>
			{change.need?.description ? (
				<p css={mutedCss}>{change.need.description}</p>
			) : null}
			<dl
				css={{
					margin: 0,
					display: 'grid',
					gridTemplateColumns: 'max-content 1fr',
					columnGap: spacing.sm,
					rowGap: spacing.xs,
					'& dt': { color: colors.textMuted },
					'& dd': { margin: 0 },
				}}
			>
				{approved ? (
					<>
						<dt>Saved</dt>
						<dd>
							<strong>{approvalAfterLabel(change)}</strong>
						</dd>
					</>
				) : (
					<>
						<dt>Now</dt>
						<dd>{approvalBeforeLabel(change)}</dd>
						<dt>After</dt>
						<dd>
							<strong>{approvalAfterLabel(change)}</strong>
							{noop ? <span css={mutedCss}> (no change)</span> : null}
						</dd>
					</>
				)}
			</dl>
			{!approved && change.willEnable && change.target.type === 'trigger' ? (
				<p css={{ margin: 0, color: colors.warningText }}>
					Approving turns on {describeTrigger(change.target.trigger)} for you.
				</p>
			) : null}
			{change.error ? (
				<p
					data-testid="approval-change-error"
					css={{ margin: 0, color: colors.danger }}
				>
					{change.error.message}
					{change.error.createUrl ? (
						<>
							{' '}
							<SiteLink href={change.error.createUrl}>
								Add a credential
							</SiteLink>
						</>
					) : null}
				</p>
			) : null}
		</li>
	)
}
function describeProposalSender(sender: CredentialProposalSender) {
	switch (sender.kind) {
		case 'member':
			return `member ${sender.value}`
		case 'address':
			return sender.value ?? 'an address'
		case 'domain':
			return `senders at ${sender.value}`
		case 'any_authenticated':
			return 'any authenticated sender'
		default: {
			const exhaustive: never = sender.kind
			throw new Error(`Unhandled sender kind: ${String(exhaustive)}`)
		}
	}
}

function renderEnable(
	entry: CredentialApprovalEnableView,
	index: number,
	approved: boolean,
	turnedOn: boolean,
) {
	const label = describeTrigger(entry.trigger)
	const status = approvalEnableStatus(entry, { approved, turnedOn })
	return (
		<li
			key={`${entry.trigger.kind}:${entry.trigger.name}`}
			data-testid={`approval-enable-${index}`}
			css={{
				...insetCardCss,
				display: 'grid',
				gap: spacing.xs,
				borderLeft: entry.error ? `4px solid ${colors.danger}` : undefined,
			}}
		>
			<strong>{label}</strong>
			{status ? (
				<p
					css={
						entry.willEnable || turnedOn
							? { margin: 0, color: colors.warningText }
							: mutedCss
					}
				>
					{status}
				</p>
			) : null}
			{entry.error ? (
				<p
					data-testid="approval-enable-error"
					css={{ margin: 0, color: colors.danger }}
				>
					{entry.error.message}
				</p>
			) : null}
		</li>
	)
}
function renderGroup(
	group: CredentialApprovalGroup,
	approved: boolean,
): ReactNode {
	return (
		<section
			key={group.key}
			aria-label={group.title}
			css={{ display: 'grid', gap: spacing.sm }}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2 css={cardTitleCss}>{group.title}</h2>
				<p css={mutedCss}>{group.description}</p>
			</div>
			<ul css={listCss}>
				{group.changes.map(({ change, index }) =>
					renderChange(change, index, approved),
				)}
			</ul>
		</section>
	)
}
export function PackageCredentialApprovalRoute({
	payload,
	currentHref,
}: {
	payload: PackageCredentialApprovalLoaderData
	currentHref: string
}) {
	const params = useParams({ strict: false })
	const path: ApprovalPath | null =
		params.username && params.kodyId
			? {
					username: params.username,
					kodyId: params.kodyId,
					search: new URL(currentHref, 'http://localhost').search,
				}
			: null
	const [latest, setLatest] = useState<{
		base: CredentialApprovalView
		view: CredentialApprovalView
		submitted: CredentialApprovalView
	} | null>(null)
	const baseView = payload.ok ? payload.view : null
	const [approving, setApproving] = useState(false)
	const [approved, setApproved] = useState(false)
	const [message, setMessage] = useState<string | null>(null)
	const capture = useSubmitterScope()
	const mutation = useCredentialMutation(
		{ orgSlug: path?.username ?? null },
		({ path, view }: { path: ApprovalPath; view: CredentialApprovalView }) =>
			approvePackageCredentials({
				data: {
					username: path.username,
					kodyId: path.kodyId,
					proposal: parseCredentialApprovalQuery(
						new URLSearchParams(path.search),
					),
					proposalId: readCredentialProposalId(
						new URLSearchParams(path.search),
					),
					fingerprint: view.fingerprint,
				},
			}),
	)
	async function approve(path: ApprovalPath, view: CredentialApprovalView) {
		if (approving || mutation.isPending || !view.canApprove || !baseView) return
		const base = baseView
		setApproving(true)
		setMessage(null)
		const isCurrent = capture()
		const response = await mutation
			.mutateAsync({ path, view })
			.catch(() => null)
		if (!isCurrent()) return
		setApproving(false)
		if (!response) {
			setMessage('Kody could not be reached. Try again.')
			return
		}
		const payload = response
		if (!isCurrent()) return
		if (payload && 'view' in payload) {
			setLatest({ base, view: payload.view, submitted: view })
		}
		if (payload?.ok) {
			setApproved(true)
		} else {
			setMessage(
				(payload && !payload.ok ? payload.error : null) ||
					'Kody could not approve these mappings.',
			)
		}
	}
	if (!path || !payload.ok) return <NotFoundPage />
	const loaded = payload.view
	const snapshot: {
		kind: string
		error?: Error
	} = { kind: 'ready' }
	const current = loaded && latest?.base === loaded ? latest : null
	const view = current ? current.view : loaded
	const reviewed = current ? current.submitted : loaded
	const pageUrl =
		typeof window === 'undefined'
			? currentHref
			: new URL(currentHref, window.location.origin).href
	const packageName = `@${path.username}/${path.kodyId}`
	const credentialsHref = routes.communityPackageCredentials.href({
		username: path.username,
		kodyId: path.kodyId,
	})
	const problems = view ? approvalProblems(view) : []
	const promptProblems = message ? [message, ...problems] : problems
	return (
		<section
			css={stackedPageCss}
			data-testid="credential-approval"
			aria-busy={snapshot.kind === 'pending' ? 'true' : undefined}
		>
			<header css={pageHeaderCss}>
				<span css={pageEyebrowCss}>Approve credential mappings</span>
				<h1 css={pageTitleCss}>
					Choose credentials for <code>{packageName}</code>
				</h1>
				<p css={pageDescriptionCss}>
					Review which credential each need of this package will use. Nothing
					changes until you approve, and approving saves every change below at
					once. Credential values are never shown.
				</p>
			</header>

			{snapshot.kind === 'error' ? (
				<section
					role="alert"
					css={{
						...cardCss,
						borderLeft: `4px solid ${colors.danger}`,
						justifyItems: 'start',
					}}
				>
					<p css={{ margin: 0 }}>
						{snapshot.error?.message ?? 'Kody could not load this approval.'}
					</p>
					<CopyTextButton
						value={credentialApprovalAgentPrompt({
							pageUrl,
							problems: [
								snapshot.error?.message ?? 'The approval did not load.',
							],
						})}
						idleLabel="Copy prompt for your agent"
					/>
				</section>
			) : null}
			{!view && snapshot.kind !== 'error' ? (
				<p css={mutedCss}>Loading the proposed mappings…</p>
			) : null}

			{view?.reason ? (
				<section
					aria-label="Note from your agent"
					data-testid="credential-approval-reason"
					css={{ ...cardCss, borderLeft: `4px solid ${colors.border}` }}
				>
					<p css={{ ...mutedCss, fontSize: typography.fontSize.sm }}>
						Note from the agent that made this link (Kody did not write this):
					</p>
					<p css={{ margin: 0, whiteSpace: 'pre-wrap' }}>{view.reason}</p>
				</section>
			) : null}

			{approved && view && reviewed ? (
				<section
					role="status"
					data-testid="credential-approval-done"
					css={{ ...cardCss, borderLeft: `4px solid ${colors.primary}` }}
				>
					<h2 css={cardTitleCss}>Approved</h2>
					<p css={{ margin: 0 }}>
						{approvalDoneCopy(reviewed)}
						{view.changes.length > 0 ? (
							<>
								{' '}
								Runs of <code>{packageName}</code> use them from now on.
							</>
						) : null}
					</p>
					<SiteLink href={credentialsHref}>
						See this package’s credentials
					</SiteLink>
				</section>
			) : null}

			{view && view.errors.length > 0 ? (
				<section
					role="alert"
					data-testid="credential-approval-errors"
					css={{ ...cardCss, borderLeft: `4px solid ${colors.danger}` }}
				>
					<h2 css={cardTitleCss}>This link has problems</h2>
					<ul css={{ margin: 0, paddingLeft: spacing.lg }}>
						{view.errors.map((error) => (
							<li key={error}>{error}</li>
						))}
					</ul>
				</section>
			) : null}

			{view &&
			view.changes.length === 0 &&
			view.enable.length === 0 &&
			view.errors.length === 0 ? (
				<section css={cardCss}>
					<p css={{ margin: 0 }}>
						This link proposes no mappings or triggers to turn on. Ask your
						agent for a new link.
					</p>
				</section>
			) : null}

			{view && view.changes.length > 0 ? (
				<section css={{ ...cardCss, gap: spacing.lg }}>
					{groupApprovalChanges(view.changes).map((group) =>
						renderGroup(group, approved),
					)}
				</section>
			) : null}

			{view && view.enable.length > 0 ? (
				<section
					aria-label="Triggers to turn on"
					css={{ ...cardCss, gap: spacing.sm }}
				>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<h2 css={cardTitleCss}>Turn on</h2>
						<p css={mutedCss}>
							Triggers this link turns on for you. Their credentials are not
							changed.
							{view.sender
								? ` Inbound email runs for ${describeProposalSender(view.sender)}.`
								: ''}
						</p>
					</div>
					<ul css={listCss}>
						{view.enable.map((entry, index) =>
							renderEnable(
								entry,
								index,
								approved,
								approved &&
									(reviewed?.enable.some(
										(candidate) =>
											candidate.willEnable &&
											candidate.trigger.kind === entry.trigger.kind &&
											candidate.trigger.name === entry.trigger.name,
									) ??
										false),
							),
						)}
					</ul>
				</section>
			) : null}

			{view &&
			!approved &&
			(view.changes.length > 0 ||
				view.enable.length > 0 ||
				problems.length > 0) ? (
				<section
					css={{
						display: 'grid',
						gap: spacing.sm,
						justifyItems: 'start',
					}}
				>
					{message ? (
						<p
							role="alert"
							data-testid="credential-approval-message"
							css={{ margin: 0, color: colors.danger }}
						>
							{message}
						</p>
					) : null}
					{!view.canApprove ? (
						<p css={mutedCss}>
							Fix the problems above before approving. Your agent can make a
							corrected link.
						</p>
					) : null}
					{promptProblems.length > 0 ? (
						<CopyTextButton
							value={credentialApprovalAgentPrompt({
								pageUrl,
								problems: promptProblems,
							})}
							idleLabel="Copy prompt for your agent"
						/>
					) : null}
					<div css={{ display: 'flex', flexWrap: 'wrap', gap: spacing.sm }}>
						<button
							type="button"
							data-testid="credential-approval-approve"
							disabled={!view.canApprove || approving}
							css={primaryButtonCss}
							onClick={() => void approve(path, view)}
						>
							{approving ? 'Approving…' : approvalSummary(view)}
						</button>
						<SiteLink
							href={credentialsHref}
							css={{
								...secondaryButtonCss,
								display: 'inline-flex',
								textDecoration: 'none',
							}}
						>
							Cancel
						</SiteLink>
					</div>
				</section>
			) : null}
		</section>
	)
}
