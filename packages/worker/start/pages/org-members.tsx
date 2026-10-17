/** @jsxImportSource @emotion/react */
import {
	inviteOrganizationMember,
	setOrganizationMemberRole,
	removeOrganizationMember,
	revokeOrganizationMemberInvite,
} from '#start/server/org-mutations'
import {
	type OrgMembersLoaderData,
	type OrgMemberView,
} from '#universal/loader-data.ts'
import { orgIdentity, orgRoleLabel } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
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
import { UserAvatar } from '../components/user-avatar.tsx'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { OrgMembersInviteLinks } from './org-members-invite-links.tsx'
import { useOrgPeopleMutation } from './org-people-mutation.ts'
const memberRoles = ['owner', 'member', 'billing'] as const
function memberName(member: OrgMemberView) {
	return (
		member.displayName?.trim() ||
		(member.username ? `@${member.username}` : member.userId)
	)
}
export function OrgMembersPage(props: {
	data: OrgMembersLoaderData
	queryKey: QueryKey
}) {
	return <OrgMembersContent key={JSON.stringify(props.queryKey)} {...props} />
}
function OrgMembersContent({
	data,
	queryKey,
}: {
	data: OrgMembersLoaderData
	queryKey: QueryKey
}) {
	const inviteMutation = useOrgPeopleMutation(
		queryKey,
		inviteOrganizationMember,
	)
	const roleMutation = useOrgPeopleMutation(queryKey, setOrganizationMemberRole)
	const removeMutation = useOrgPeopleMutation(
		queryKey,
		removeOrganizationMember,
	)
	const revokeMutation = useOrgPeopleMutation(
		queryKey,
		revokeOrganizationMemberInvite,
	)
	const pending =
		inviteMutation.isPending ||
		roleMutation.isPending ||
		removeMutation.isPending ||
		revokeMutation.isPending
	const capture = useSubmitterScope()
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const [invitee, setInvitee] = useState(''),
		[inviteRole, setInviteRole] = useState<'owner' | 'member' | 'billing'>(
			'member',
		),
		[invitePrompt, setInvitePrompt] = useState<string | null>(null),
		[confirmed, setConfirmed] = useState<string | null>(null),
		[inviteRevision, setInviteRevision] = useState(0)
	const args = { orgSlug: data.org.slug }
	const ownerCount = data.members.filter(
		(member) => member.role === 'owner',
	).length
	async function post<T>(
		perform: () => Promise<T>,
		success: string,
		done?: (result: T) => void,
	) {
		const active = capture()
		setMessage(null)
		try {
			const result = await perform()
			if (!active()) return
			done?.(result)
			setMessage({ text: success, tone: 'info' })
		} catch (error) {
			if (active())
				setMessage({
					text:
						error instanceof Error ? error.message : 'Unable to save changes.',
					tone: 'error',
				})
		}
	}

	return (
		<AccountManagementShell currentHref={routes.orgMembers.href(args)}>
			<AccountPageHeader
				title="Members"
				description="People who belong to this organization."
				currentHref={routes.orgMembers.href(args)}
			/>
			{message?.text ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			{invitePrompt ? (
				<pre css={promptCss} data-testid="invite-prompt">
					{invitePrompt}
				</pre>
			) : null}
			<AccountManagementPanel title="People" ariaLabel="Organization members">
				<ul css={listCss} data-testid="org-members">
					{data.members.map((member) => {
						const lastOwner = member.role === 'owner' && ownerCount <= 1
						const identity = orgIdentity(
							{
								slug: member.username ?? member.userId,
								displayName: member.displayName,
								personal: false,
								avatarUrl: member.avatarUrl,
							},
							{ displayName: '', avatarUrl: null },
						)
						const updatingRole =
							roleMutation.isPending &&
							roleMutation.variables?.userId === member.userId
						return (
							<li key={member.userId} data-testid="org-member" css={rowItemCss}>
								<div css={rowCss}>
									<UserAvatar
										displayName={identity.avatarName}
										avatarUrl={member.avatarUrl}
										size={44}
										variant="well"
									/>
									<span css={rowTextCss}>
										<span css={rowNameCss}>{memberName(member)}</span>
										<span css={rowDetailCss}>
											{member.username
												? `@${member.username} · ${member.roleLabel}`
												: member.roleLabel}
										</span>
									</span>
									{data.canManage ? (
										<span css={rowActionsCss}>
											<select
												aria-label={`Role for ${memberName(member)}`}
												value={
													updatingRole
														? String(roleMutation.variables?.role)
														: member.role
												}
												disabled={lastOwner || pending}
												css={selectCss}
												onChange={(event) =>
													post(
														() =>
															roleMutation.mutateAsync({
																...args,
																userId: member.userId,
																role: event.currentTarget
																	.value as typeof member.role,
															}),
														'Role updated.',
													)
												}
											>
												{memberRoles.map((role) => (
													<option key={role} value={role}>
														{orgRoleLabel(role)}
													</option>
												))}
											</select>
											<button
												type="button"
												disabled={lastOwner || pending}
												css={getDangerPillCss({ size: 'sm' })}
												onBlur={() => setConfirmed(null)}
												onClick={() => {
													if (confirmed !== member.userId) {
														setConfirmed(member.userId)
														return
													}
													setConfirmed(null)
													post(
														() =>
															removeMutation.mutateAsync({
																...args,
																userId: member.userId,
															}),
														'Member removed.',
													)
												}}
											>
												{renderIcon('user-cross', { size: '1.05rem' })}
												{confirmed === member.userId
													? 'Confirm remove'
													: 'Remove'}
											</button>
										</span>
									) : (
										<span css={rowActionsCss}>
											<span css={quietPillCss}>{member.roleLabel}</span>
										</span>
									)}
								</div>
							</li>
						)
					})}
				</ul>
			</AccountManagementPanel>
			{data.canManage ? (
				<>
					<OrgMembersInviteLinks
						clearRevision={inviteRevision}
						links={data.inviteLinks}
						slug={data.org.slug}
						queryKey={queryKey}
						onMessage={(text, tone) => setMessage({ text, tone })}
					/>
					<AccountManagementPanel title="Invite by email or username">
						<form
							data-testid="org-invite-form"
							css={formCss}
							onSubmit={(event) => {
								event.preventDefault()
								setInvitePrompt(null)
								setInviteRevision((value) => value + 1)
								post(
									() =>
										inviteMutation.mutateAsync({
											...args,
											invitee,
											role: inviteRole,
										}),
									'Invite created. Send this prompt to them.',
									(result) => {
										setInvitee('')
										setInvitePrompt(result.invite?.prompt ?? null)
									},
								)
							}}
						>
							<label css={accountFieldCss}>
								<span css={accountFieldLabelCss}>Email or username</span>
								<input
									value={invitee}
									required
									data-field-ring
									autoComplete="off"
									css={accountInputCss}
									onChange={(event) => setInvitee(event.currentTarget.value)}
								/>
								<p css={accountFieldNoteCss}>
									It waits on their Waiting page, or they can paste the invite
									prompt into their agent.
								</p>
							</label>
							<label css={accountFieldCss}>
								<span css={accountFieldLabelCss}>Role</span>
								<select
									value={inviteRole}
									css={selectCss}
									onChange={(event) =>
										setInviteRole(
											event.currentTarget.value as typeof inviteRole,
										)
									}
								>
									{memberRoles.map((role) => (
										<option key={role} value={role}>
											{orgRoleLabel(role)}
										</option>
									))}
								</select>
							</label>
							<div css={accountActionsCss}>
								<button
									type="submit"
									disabled={pending || invitee.trim().length === 0}
									css={getPillButtonCss({ size: 'sm' })}
								>
									{renderIcon('plus', { size: '1.05rem' })}
									{inviteMutation.isPending ? 'Inviting…' : 'Send invite'}
								</button>
							</div>
						</form>
					</AccountManagementPanel>
				</>
			) : null}
			{data.canManage && data.invites.length > 0 ? (
				<AccountManagementPanel title="Pending invites">
					<ul css={listCss} data-testid="org-invites">
						{data.invites.map((invite) => (
							<li key={invite.id} css={rowItemCss} data-testid="org-invite">
								<div css={rowCss}>
									<span aria-hidden="true" css={inviteIconCss}>
										{renderIcon('mail', { size: '1.25rem' })}
									</span>
									<span css={rowTextCss}>
										<span css={rowNameCss}>
											{invite.inviteeEmail ??
												(invite.inviteeUsername
													? `@${invite.inviteeUsername}`
													: 'Invite')}
										</span>
										<span css={rowDetailCss}>
											{invite.kind === 'membership'
												? invite.roleLabel
												: 'Access grant'}{' '}
											· Pending · Expires{' '}
											{formatTimestampDate(invite.expiresAt)}
										</span>
									</span>
									{invite.kind === 'membership' ? (
										<button
											type="button"
											disabled={pending}
											data-testid="org-invite-revoke"
											css={getDangerPillCss({ size: 'sm' })}
											onClick={() =>
												post(
													() =>
														revokeMutation.mutateAsync({
															...args,
															inviteId: invite.id,
														}),
													'Invite revoked.',
												)
											}
										>
											{revokeMutation.isPending &&
											revokeMutation.variables?.inviteId === invite.id
												? 'Revoking…'
												: 'Revoke'}
										</button>
									) : null}
								</div>
							</li>
						))}
					</ul>
				</AccountManagementPanel>
			) : null}
		</AccountManagementShell>
	)
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
	// A phone row cannot hold the avatar, name, role select, and Remove
	// button. Stack the actions under the identity so they cannot cover it.
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
	// Zero basis keeps a long detail beside the avatar on a phone row.
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

const quietPillCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	fontSize: '0.8rem',
	fontWeight: 600,
	borderRadius: radius.full,
	padding: '0.1rem 0.6rem',
	color: colors.textMuted,
	boxShadow: `inset 0 0 0 1px ${colors.border}`,
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
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

const promptCss: CSSObject = {
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.card,
	backgroundColor: colors.background,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}
