/** @jsxImportSource @emotion/react */
import {
	createOrganizationInviteLink,
	revokeOrganizationInviteLink,
} from '#start/server/org-mutations'
import {
	type OrgInviteLinkView,
	type OrgMembersTeamOption,
} from '#universal/loader-data.ts'
import { orgRoleLabel } from '#universal/org-pages.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
	getSelectCss,
	getGhostButtonCss,
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
	teams,
	slug,
	queryKey,
	onMessage,
	clearRevision,
}: {
	clearRevision: number
	links: ReadonlyArray<OrgInviteLinkView>
	teams: ReadonlyArray<OrgMembersTeamOption>
	slug: string
	queryKey: QueryKey
	onMessage: (message: string, tone: 'info' | 'error') => void
}) {
	const [formOpen, setFormOpen] = useState(false)
	const [role, setRole] = useState<'member' | 'billing'>('member')
	const [label, setLabel] = useState('')
	const [selectedTeamIds, setSelectedTeamIds] = useState<Array<string>>([])
	const [domains, setDomains] = useState('')
	const [maxUses, setMaxUses] = useState('')
	const [days, setDays] = useState('7')
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

	function resetFormFields() {
		setRole('member')
		setLabel('')
		setSelectedTeamIds([])
		setDomains('')
		setMaxUses('')
		setDays('7')
	}

	function closeForm() {
		setFormOpen(false)
		resetFormFields()
	}

	function toggleTeam(teamId: string) {
		setSelectedTeamIds((current) =>
			current.includes(teamId)
				? current.filter((id) => id !== teamId)
				: [...current, teamId],
		)
	}

	async function createLink() {
		const active = capture()
		onMessage('', 'info')
		try {
			const result = await createMutation.mutateAsync({
				orgSlug: slug,
				role,
				label: label.trim() || undefined,
				teamIds: selectedTeamIds,
				allowedEmailDomains: domains,
				maxUses: maxUses.trim() || null,
				expiresInDays: days.trim() || '7',
			})
			if (!active()) return
			const url = result.inviteLink.url
			const copied = await copyText(url)
			if (!active()) return
			setCopiedLink({ id: result.inviteLink.id, url, revision: clearRevision })
			resetFormFields()
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
		<AccountManagementPanel
			title="Invite links"
			description="Share a link so people can join without knowing their email. The full URL is shown once."
		>
			{links.length > 0 ? (
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
									<span css={rowNameCss}>
										{link.label?.trim() || `${link.roleLabel} link`}
									</span>
									<span css={rowDetailCss}>
										{link.roleLabel}
										{link.teamNames.length > 0
											? ` · Teams ${link.teamNames.join(', ')}`
											: ''}
										{' · '}
										{link.useCount}
										{link.maxUses != null ? ` / ${link.maxUses}` : ''} uses
										{link.lastUsedAt ? (
											<> · Last used {formatTimestampDate(link.lastUsedAt)}</>
										) : null}
										{' · '}Expires {formatTimestampDate(link.expiresAt)} ·
										Created by{' '}
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
			) : (
				<p css={emptyCss} data-testid="org-invite-links-empty">
					No active invite links.
				</p>
			)}

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

			{formOpen ? (
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
							data-field-ring
							css={roleSelectCss}
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
						<span css={accountFieldLabelCss}>Label (optional)</span>
						<input
							value={label}
							data-field-ring
							autoComplete="off"
							placeholder="Engineering onboarding"
							css={accountInputCss}
							onChange={(event) => setLabel(event.currentTarget.value)}
						/>
						<p css={accountFieldNoteCss}>
							Helps you tell your links apart. Only admins see it.
						</p>
					</label>
					{teams.length > 0 ? (
						<fieldset css={teamFieldsetCss}>
							<span css={accountFieldLabelCss}>Default teams (optional)</span>
							<p css={accountFieldNoteCss}>
								People who join with this link are also added to these teams.
							</p>
							<ul css={teamListCss}>
								{teams.map((team) => {
									const checked = selectedTeamIds.includes(team.id)
									return (
										<li key={team.id}>
											<label css={teamOptionCss}>
												<input
													type="checkbox"
													checked={checked}
													onChange={() => toggleTeam(team.id)}
												/>
												<span>{team.name}</span>
											</label>
										</li>
									)
								})}
							</ul>
						</fieldset>
					) : null}
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
						<p css={accountFieldNoteCss}>
							Links expire after 7 days by default (up to 365).
						</p>
					</label>
					<p css={accountFieldNoteCss}>
						Copy the link now. Kody only stores a hash, so you can&apos;t see it
						again later.
					</p>
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
						<button
							type="button"
							disabled={creating}
							css={getGhostButtonCss({ size: 'sm' })}
							onClick={closeForm}
						>
							Cancel
						</button>
					</div>
				</form>
			) : (
				<div css={accountActionsCss}>
					<button
						type="button"
						disabled={pending}
						css={getPillButtonCss({ size: 'sm' })}
						data-testid="org-invite-link-open-create"
						onClick={() => setFormOpen(true)}
					>
						{renderIcon('plus', { size: '1.05rem' })}
						Create invite link
					</button>
				</div>
			)}
		</AccountManagementPanel>
	)
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
	marginTop: spacing.md,
}

const teamFieldsetCss: CSSObject = {
	...accountFieldCss,
	border: 0,
	margin: 0,
	padding: 0,
	minWidth: 0,
}

const teamListCss: CSSObject = {
	listStyle: 'none',
	margin: `${spacing.sm} 0 0`,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
}

const teamOptionCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	fontSize: typography.fontSize.sm,
}

const roleSelectCss: CSSObject = {
	...getSelectCss(),
	// Match the People row Owner select: keep the control compact inside the
	// form grid (grid items stretch to full width by default).
	width: 'auto',
	minWidth: '8rem',
	justifySelf: 'start',
	[mq.mobile]: {
		minWidth: 'min(100%, 8rem)',
		maxWidth: '100%',
	},
}

const emptyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
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
	},
}

const rowDetailCss: CSSObject = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
}

const rowActionsCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexShrink: 0,
	[mq.mobile]: {
		width: '100%',
		justifyContent: 'flex-end',
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
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap',
	marginTop: spacing.md,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const copiedLinkCodeCss: CSSObject = {
	flex: '1 1 12rem',
	minWidth: 0,
	overflowWrap: 'anywhere',
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
}
