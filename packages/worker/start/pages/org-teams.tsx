/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import { Button } from '../components/button.tsx'
import { OrgTeamInviteLinks } from './org-teams-invite-links.tsx'
import {
	createOrganizationTeam,
	addOrganizationTeamMember,
	removeOrganizationTeamMember,
} from '#start/server/org-mutations'
import type { OrgTeamsLoaderData } from '#universal/loader-data.ts'
import { orgIdentity } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import type { CSSObject } from '@emotion/react'
import type { QueryKey } from '@tanstack/react-query'
import { useState } from 'react'
import { renderIcon } from '../components/icon.tsx'
import { UserAvatar } from '../components/user-avatar.tsx'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
} from './account-management-components.tsx'
import { useOrgPeopleMutation } from './org-people-mutation.ts'
import { Input, Select } from '../components/input.tsx'

function memberLabel(member: {
	displayName: string | null
	username: string | null
	userId: string
}) {
	return (
		member.displayName?.trim() ||
		(member.username ? `@${member.username}` : member.userId)
	)
}
export function OrgTeamsPage(props: {
	data: OrgTeamsLoaderData
	queryKey: QueryKey
}) {
	return <OrgTeamsContent key={JSON.stringify(props.queryKey)} {...props} />
}
function OrgTeamsContent({
	data,
	queryKey,
}: {
	data: OrgTeamsLoaderData
	queryKey: QueryKey
}) {
	const createMutation = useOrgPeopleMutation(queryKey, createOrganizationTeam)
	const addMutation = useOrgPeopleMutation(queryKey, addOrganizationTeamMember)
	const removeMutation = useOrgPeopleMutation(
		queryKey,
		removeOrganizationTeamMember,
	)
	const pending =
		createMutation.isPending ||
		addMutation.isPending ||
		removeMutation.isPending
	const capture = useSubmitterScope()
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const [createSlug, setCreateSlug] = useState(''),
		[createName, setCreateName] = useState(''),
		[createDescription, setCreateDescription] = useState('')
	const [addByTeam, setAddByTeam] = useState<Record<string, string>>({})
	const [confirmed, setConfirmed] = useState<string | null>(null)
	const args = { orgSlug: data.org.slug }
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
		<AccountManagementShell
			layout="list"
			currentHref={routes.orgTeams.href(args)}
		>
			<AccountPageHeader
				entity="teams"
				title="Teams"
				description="Groups inside this organization for package grants and shared work."
				currentHref={routes.orgTeams.href(args)}
			/>
			{message ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			<AccountManagementPanel title="Teams" ariaLabel="Organization teams">
				{data.teams.length === 0 ? (
					<p css={mutedCopyCss} data-testid="org-teams-empty">
						No teams yet.
					</p>
				) : (
					<ul css={listCss} data-testid="org-teams">
						{data.teams.map((team) => (
							<li key={team.id} data-testid="org-team" css={teamCardCss}>
								<div css={teamHeaderCss}>
									<span css={rowTextCss}>
										<span css={rowNameCss}>{team.name}</span>
										<span css={rowDetailCss}>
											@{team.slug}
											{team.description?.trim()
												? ` · ${team.description.trim()}`
												: ''}
											{` · ${team.memberCount} member${team.memberCount === 1 ? '' : 's'}`}
										</span>
									</span>
								</div>
								{team.members.length > 0 ? (
									<ul css={memberListCss}>
										{team.members.map((member) => {
											const key = `${team.id}:${member.userId}`
											const identity = orgIdentity(
												{
													slug: member.username ?? member.userId,
													displayName: member.displayName,
													personal: false,
													avatarUrl: member.avatarUrl,
												},
												{ displayName: '', avatarUrl: null },
											)
											return (
												<li key={member.userId} css={rowItemCss}>
													<div css={rowCss}>
														<UserAvatar
															displayName={identity.avatarName}
															avatarUrl={member.avatarUrl}
															size={36}
															variant="well"
														/>
														<span css={rowTextCss}>
															<span css={rowNameCss}>
																{memberLabel(member)}
															</span>
															{member.username ? (
																<span css={rowDetailCss}>
																	@{member.username}
																</span>
															) : null}
														</span>
														{data.canRemoveMembers ? (
															<Button
																type="button"
																disabled={pending}
																variant="danger"
																onBlur={() => setConfirmed(null)}
																onClick={() => {
																	if (confirmed !== key) {
																		setConfirmed(key)
																		return
																	}
																	setConfirmed(null)
																	post(
																		() =>
																			removeMutation.mutateAsync({
																				...args,
																				teamId: team.id,
																				userId: member.userId,
																			}),
																		'Member removed from the team.',
																	)
																}}
															>
																{renderIcon('user-cross', { size: '1.05rem' })}
																{confirmed === key
																	? 'Confirm remove'
																	: 'Remove'}
															</Button>
														) : null}
													</div>
												</li>
											)
										})}
									</ul>
								) : (
									<p css={mutedCopyCss}>No members on this team.</p>
								)}
								{data.canManage ? (
									<div css={addRowCss}>
										<Select
											aria-label={`Add member to ${team.name}`}
											value={addByTeam[team.id] ?? ''}
											css={selectCss}
											onChange={(event) =>
												setAddByTeam({
													...addByTeam,
													[team.id]: event.currentTarget.value,
												})
											}
										>
											<option value="">Add a member…</option>
											{data.orgMembers
												.filter(
													(member) =>
														!team.members.some(
															(item) => item.userId === member.userId,
														),
												)
												.map((member) => (
													<option key={member.userId} value={member.userId}>
														{memberLabel(member)}
													</option>
												))}
										</Select>
										<Button
											type="button"
											disabled={!addByTeam[team.id] || pending}
											variant="primary"
											onClick={() =>
												post(
													() =>
														addMutation.mutateAsync({
															...args,
															teamId: team.id,
															userId: addByTeam[team.id] ?? '',
														}),
													'Member added to the team.',
													() =>
														setAddByTeam((current) => ({
															...current,
															[team.id]: '',
														})),
												)
											}
										>
											{renderIcon('plus', { size: '1.05rem' })}Add
										</Button>
									</div>
								) : null}
								{data.canCreateInviteLinks ? (
									<OrgTeamInviteLinks
										team={team}
										links={data.inviteLinks}
										orgSlug={data.org.slug}
										queryKey={queryKey}
										onMessage={(text, tone) => setMessage({ text, tone })}
									/>
								) : null}
							</li>
						))}
					</ul>
				)}
			</AccountManagementPanel>
			{data.canManage ? (
				<AccountManagementPanel title="Create team">
					<form
						data-testid="org-team-create-form"
						css={formCss}
						onSubmit={(event) => {
							event.preventDefault()
							post(
								() =>
									createMutation.mutateAsync({
										...args,
										slug: createSlug,
										name: createName,
										description: createDescription,
									}),
								'Team created.',
								() => {
									setCreateSlug('')
									setCreateName('')
									setCreateDescription('')
								},
							)
						}}
					>
						<Field
							label="Handle"
							description="Unique inside this organization. Lowercase letters, numbers, and hyphens."
						>
							<Input
								value={createSlug}
								required
								autoComplete="off"
								onChange={(event) => setCreateSlug(event.currentTarget.value)}
							/>
						</Field>
						<Field label="Name">
							<Input
								value={createName}
								autoComplete="off"
								onChange={(event) => setCreateName(event.currentTarget.value)}
							/>
						</Field>
						<Field label="Description">
							<Input
								value={createDescription}
								autoComplete="off"
								onChange={(event) =>
									setCreateDescription(event.currentTarget.value)
								}
							/>
						</Field>
						<div css={accountActionsCss}>
							<Button
								type="submit"
								disabled={pending || createSlug.trim().length === 0}
								variant="primary"
							>
								{renderIcon('plus', { size: '1.05rem' })}
								{createMutation.isPending ? 'Creating…' : 'Create team'}
							</Button>
						</div>
					</form>
				</AccountManagementPanel>
			) : null}
		</AccountManagementShell>
	)
}
const mutedCopyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
}

const listCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.md,
}

const memberListCss: CSSObject = {
	listStyle: 'none',
	margin: `${spacing.sm} 0 0`,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const teamCardCss: CSSObject = {
	minWidth: 0,
	padding: '1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	display: 'grid',
	gap: spacing.sm,
}

const teamHeaderCss: CSSObject = {
	display: 'flex',
	alignItems: 'flex-start',
	justifyContent: 'space-between',
	gap: spacing.md,
}

const rowItemCss: CSSObject = {
	minWidth: 0,
}

const rowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
}

const rowTextCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 auto',
}

const rowNameCss: CSSObject = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const rowDetailCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const addRowCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
	marginTop: spacing.sm,
}

const selectCss: CSSObject = {
	width: 'auto',
	minWidth: '12rem',
	flex: '1 1 auto',
	padding: '0.45rem 0.7rem',
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
}
