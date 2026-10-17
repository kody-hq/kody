/** @jsxImportSource @emotion/react */
import {
	usePendingInviteActions,
	renderPendingInviteActions,
	type PendingInviteActions,
} from './pending-invite-actions.tsx'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { recordWaitingClick } from '#start/server/account-mutations'
import { SiteLink } from '../components/site-link.tsx'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'

import { type AccountWaitingLoaderData } from '#universal/loader-data.ts'
import { relocateAccountHref } from '#universal/org-pages.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { type WaitingSeverity } from '#universal/waiting.ts'
import {
	AccountManagementPanel,
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
	noticeCardCss,
} from './account-management-components.tsx'

const severityAccent: Record<WaitingSeverity, string> = {
	block: colors.danger,
	degraded: colors.primary,
	setup: colors.border,
}

export function AccountWaitingPage({
	payload: initialPayload,
	currentHref,
}: {
	payload: AccountWaitingLoaderData
	currentHref: string
}) {
	const inviteActions = usePendingInviteActions()
	const data = initialPayload
	const { orgSlug } = useMatchedPageScope()

	return (
		<AccountManagementShell currentHref={currentHref} busy={false}>
			<AccountPageHeader
				entity="waiting"
				title="Waiting"
				description="Things that need you."
				currentHref={currentHref}
			/>

			{inviteActions.message ? (
				<AccountManagementMessage tone={inviteActions.tone}>
					{inviteActions.message}
				</AccountManagementMessage>
			) : null}
			{data
				? renderWaitingBody(data, currentHref, orgSlug, inviteActions)
				: null}
		</AccountManagementShell>
	)
}

function renderWaitingBody(
	data: AccountWaitingLoaderData,
	currentHref: string,
	orgSlug: string | null,
	inviteActions: PendingInviteActions,
) {
	const items = data.items
	if (items.length === 0 && data.invites.length === 0) {
		return (
			<AccountManagementPanel
				title="Nothing is waiting on you"
				description="Connections are healthy, no invites are waiting, and no publishes or grants need a click."
			>
				<p css={{ margin: 0, color: colors.textMuted }}>
					<SiteLink
						href={relocateAccountHref('/account/activity', currentHref)}
					>
						Activity
					</SiteLink>{' '}
					is run history.{' '}
					<SiteLink href={relocateAccountHref('/account/email', currentHref)}>
						Email
					</SiteLink>{' '}
					is your mailbox.
				</p>
			</AccountManagementPanel>
		)
	}

	return (
		<div
			css={{
				display: 'grid',
				gap: spacing.md,
			}}
		>
			{data.invites.map((invite) => (
				<section
					key={`invite:${invite.source}:${invite.id}`}
					data-testid="waiting-invite"
					css={{
						...noticeCardCss,
						...getAccentCalloutCss({ accentColor: colors.primary }),
					}}
				>
					<h2
						css={{
							margin: 0,
							fontSize: '1.05rem',
							fontWeight: 700,
							letterSpacing: '-0.01em',
							lineHeight: 1.3,
						}}
					>
						{invite.label}
					</h2>
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: '0.95rem',
							lineHeight: 1.5,
						}}
					>
						Invite from {invite.orgDisplayName?.trim() || `@${invite.orgSlug}`}{' '}
						· Expires {formatTimestampDate(invite.expiresAt)}
					</p>
					{renderPendingInviteActions(invite, inviteActions)}
				</section>
			))}
			{items.map((item) => (
				<section
					key={item.id}
					data-testid={`waiting-item-${item.kind}`}
					css={{
						...noticeCardCss,
						...getAccentCalloutCss({
							accentColor: severityAccent[item.severity],
						}),
					}}
				>
					<h2
						css={{
							margin: 0,
							fontSize: '1.05rem',
							fontWeight: 700,
							letterSpacing: '-0.01em',
							lineHeight: 1.3,
						}}
					>
						{item.title}
					</h2>
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: '0.95rem',
							lineHeight: 1.5,
						}}
					>
						{item.why}
					</p>
					<SiteLink
						href={relocateAccountHref(item.href, currentHref)}
						onClick={() => {
							void recordWaitingClick({
								data: {
									cardId: item.id,
									orgSlug: orgSlug ?? undefined,
								},
							}).catch(() => {})
						}}
						css={{
							...getPillButtonCss({ size: 'sm' }),
							width: 'fit-content',
							textDecoration: 'none',
						}}
					>
						{item.doLabel}
					</SiteLink>
				</section>
			))}
		</div>
	)
}
