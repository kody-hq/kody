/** @jsxImportSource @emotion/react */
import {
	createOrganizationInviteLink,
	revokeOrganizationInviteLink,
} from '#start/server/org-mutations'
import { type OrgInviteLinkView } from '#universal/loader-data.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { type CSSObject } from '@emotion/react'
import { type QueryKey } from '@tanstack/react-query'
import { useState } from 'react'
import { renderIcon } from '../components/icon.tsx'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { useInviteHandoff } from '../use-invite-handoff.ts'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'
import { useOrgPeopleMutation } from './org-people-mutation.ts'
async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}
export function OrgMembersInviteLinks({
	links,
	slug,
	queryKey,
	onMessage,
	clearRevision,
}: {
	clearRevision: number
	links: ReadonlyArray<OrgInviteLinkView>
	slug: string
	queryKey: QueryKey
	onMessage: (message: string, tone: 'info' | 'error') => void
}) {
	const [role, setRole] = useState<'member' | 'billing'>('member'),
		[domains, setDomains] = useState(''),
		[maxUses, setMaxUses] = useState(''),
		[days, setDays] = useState('7')
	const [copiedLink, setCopiedLink] = useInviteHandoff<{
		id: string
		url: string
		revision: number
	}>(links)
	const copiedLinkUrl =
		copiedLink?.revision === clearRevision ? copiedLink.url : null
	const createMutation = useOrgPeopleMutation(
		queryKey,
		createOrganizationInviteLink,
	)
	const revokeMutation = useOrgPeopleMutation(
		queryKey,
		revokeOrganizationInviteLink,
	)
	const capture = useSubmitterScope()
	const creating = createMutation.isPending
	const pending = creating || revokeMutation.isPending
	async function createLink() {
		const active = capture()
		onMessage('', 'info')
		try {
			const result = await createMutation.mutateAsync({
				orgSlug: slug,
				role,
				allowedEmailDomains: domains,
				maxUses: maxUses.trim() || null,
				expiresInDays: days.trim() || '7',
			})
			if (!active()) return
			const url = result.inviteLink.url
			const copied = await copyText(url)
			if (!active()) return
			setCopiedLink({ id: result.inviteLink.id, url, revision: clearRevision })
			onMessage(
				copied
					? 'Invite link copied to clipboard.'
					: 'Invite link created. Copy it below.',
				'info',
			)
		} catch (error) {
			if (active())
				onMessage(
					error instanceof Error
						? error.message
						: 'Unable to create invite link.',
					'error',
				)
		}
	}
	async function revokeLink(linkId: string) {
		const active = capture()
		onMessage('', 'info')
		try {
			await revokeMutation.mutateAsync({ orgSlug: slug, linkId })
			if (active()) {
				setCopiedLink((current) => (current?.id === linkId ? null : current))
				onMessage('Invite link revoked.', 'info')
			}
		} catch (error) {
			if (active())
				onMessage(
					error instanceof Error
						? error.message
						: 'Unable to revoke invite link.',
					'error',
				)
		}
	}

	return (
		<>
			<AccountManagementPanel title="Invite link">
				<form
					data-testid="org-invite-link-form"
					css={formCss}
					onSubmit={(event) => {
						event.preventDefault()
						void createLink()
					}}
				>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Role</span>
						<select
							value={role}
							aria-label="Invite link role"
							css={selectCss}
							onChange={(event) =>
								setRole(event.currentTarget.value as typeof role)
							}
						>
							{(['member', 'billing'] as const).map((value) => (
								<option key={value} value={value}>
									{orgRoleLabel(value)}
								</option>
							))}
						</select>
						<p css={accountFieldNoteCss}>
							Anyone with the link joins as this role. Owner cannot be granted
							through a link.
						</p>
					</label>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>
							Allowed email domains (optional)
						</span>
						<input
							value={domains}
							data-field-ring
							autoComplete="off"
							placeholder="example.com, partner.org"
							css={accountInputCss}
							onChange={(event) => setDomains(event.currentTarget.value)}
						/>
						<p css={accountFieldNoteCss}>
							Leave blank to allow any verified email. Domains check the
							account’s verified email.
						</p>
					</label>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Max uses (optional)</span>
						<input
							value={maxUses}
							data-field-ring
							inputMode="numeric"
							autoComplete="off"
							placeholder="Unlimited"
							css={accountInputCss}
							onChange={(event) => setMaxUses(event.currentTarget.value)}
						/>
					</label>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Expires in days</span>
						<input
							value={days}
							data-field-ring
							inputMode="numeric"
							autoComplete="off"
							css={accountInputCss}
							onChange={(event) => setDays(event.currentTarget.value)}
						/>
					</label>
					<div css={accountActionsCss}>
						<button
							type="submit"
							disabled={pending}
							css={getPillButtonCss({ size: 'sm' })}
							data-testid="org-invite-link-copy"
						>
							{renderIcon('link', { size: '1.05rem' })}
							{creating ? 'Creating…' : 'Copy invite link'}
						</button>
					</div>
				</form>
				{copiedLinkUrl ? (
					<div css={copiedLinkCss} data-testid="invite-link-url">
						<code css={copiedLinkCodeCss}>{copiedLinkUrl}</code>
						<button
							type="button"
							css={getPillButtonCss({ size: 'sm' })}
							onClick={async () => {
								const active = capture()
								const copied = await copyText(copiedLinkUrl)
								if (active())
									onMessage(
										copied
											? 'Invite link copied to clipboard.'
											: 'Could not copy the link. Select it manually.',
										copied ? 'info' : 'error',
									)
							}}
						>
							{renderIcon('copy', { size: '1.05rem' })}Copy again
						</button>
					</div>
				) : null}
			</AccountManagementPanel>
			{links.length > 0 ? (
				<AccountManagementPanel title="Active invite links">
					<ul css={listCss} data-testid="org-invite-links">
						{links.map((link) => (
							<li
								key={link.id}
								css={rowItemCss}
								data-testid="org-invite-link"
								data-invite-link-id={link.id}
							>
								<div css={rowCss}>
									<span aria-hidden="true" css={inviteIconCss}>
										{renderIcon('link', { size: '1.25rem' })}
									</span>
									<span css={rowTextCss}>
										<span css={rowNameCss}>{link.roleLabel} link</span>
										<span css={rowDetailCss}>
											{link.useCount}
											{link.maxUses != null ? ` / ${link.maxUses}` : ''} uses ·
											Expires {formatTimestampDate(link.expiresAt)} · Created by{' '}
											{link.createdByDisplayName?.trim() ||
												(link.createdByUsername
													? `@${link.createdByUsername}`
													: 'Someone')}
											{link.allowedEmailDomains.length > 0
												? ` · Domains ${link.allowedEmailDomains.join(', ')}`
												: ''}
										</span>
									</span>
									<span css={rowActionsCss}>
										<button
											type="button"
											disabled={pending}
											css={getDangerPillCss({ size: 'sm' })}
											onClick={() => void revokeLink(link.id)}
										>
											{revokeMutation.isPending &&
											revokeMutation.variables?.linkId === link.id
												? 'Revoking…'
												: 'Revoke'}
										</button>
									</span>
								</div>
							</li>
						))}
					</ul>
				</AccountManagementPanel>
			) : null}
		</>
	)
}
const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
}

const selectCss: CSSObject = {
	...accountInputCss,
	width: 'auto',
	minWidth: '8rem',
	padding: '0.45rem 0.7rem',
	[mq.mobile]: {
		minWidth: 'min(100%, 8rem)',
		maxWidth: '100%',
	},
}

const listCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const rowItemCss: CSSObject = {
	minWidth: 0,
}

const rowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	[mq.mobile]: {
		flexWrap: 'wrap',
		alignItems: 'flex-start',
	},
}

const rowTextCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
	// Zero basis keeps a long detail beside the icon on a phone row.
	[mq.mobile]: {
		flex: '1 1 0%',
		maxWidth: '100%',
	},
}

const rowNameCss: CSSObject = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	[mq.mobile]: {
		whiteSpace: 'normal',
		overflowWrap: 'anywhere',
	},
}

const rowDetailCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	minWidth: 0,
	[mq.mobile]: {
		overflowWrap: 'anywhere',
	},
}

const rowActionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
	flexShrink: 0,
	[mq.mobile]: {
		flex: '1 0 100%',
		maxWidth: '100%',
		minWidth: 0,
	},
}

const inviteIconCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	flexShrink: 0,
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
}

const copiedLinkCss: CSSObject = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.lg,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const copiedLinkCodeCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
	color: colors.text,
}
