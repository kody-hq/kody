/** @jsxImportSource @emotion/react */
import { useRef, useState, type FormEvent } from 'react'
import { PackageInviteLinksPanel } from './package-collaborators-invite-links.tsx'
import { PackageCollaboratorInvites } from './package-collaborators-invites.tsx'
import {
	useMutation,
	useMutationState,
	useQueryClient,
} from '@tanstack/react-query'
import { SiteLink } from '../components/site-link.tsx'
import {
	grantPackageCollaborator,
	revokePackageCollaborator,
	createPackageCollaboratorInvite,
	revokePackageCollaboratorInvite,
} from '#start/server/package-collaborators'
import {
	collaboratorsMutationKey,
	collaboratorsMutationOptions,
	type CollaboratorsMutationInput,
} from '../package-collaborators-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
} from './account-management-components.tsx'
import { renderIcon } from '../components/icon.tsx'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import {
	type PackageCollaboratorPreset,
	type PackageCollaboratorsChange,
	type PackageCollaboratorsLoaderData,
	type PackageCollaboratorsView,
	type PackageCollaboratorView,
	packageCollaboratorPresetDescription,
	packageCollaboratorPresetLabel,
} from '#universal/package-collaborators.ts'
import {
	fallbackDefaultBranchName,
	getPackageTreeHref,
} from '#universal/package-files.ts'
import { renderPackageRepoChrome } from '../components/package-repo-nav.tsx'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { UserAvatar } from '../components/user-avatar.tsx'
import { detailArticleCss } from '../components/community-detail-sections.tsx'
import {
	collaboratorDetail,
	collaboratorName,
	formCss,
	iconWellCss,
	listCss,
	mutedCopyCss,
	readPreset,
	renderPresetOptions,
	rowActionsCss,
	rowCss,
	rowDetailCss,
	rowNameCss,
	rowTextCss,
	selectCss,
} from './package-collaborators-parts.tsx'

export function PackageCollaboratorsRoute({
	payload,
	actorKey,
}: {
	payload: Extract<PackageCollaboratorsLoaderData, { ok: true }>
	actorKey: string | null
}) {
	const client = useQueryClient()
	const { shell, view } = payload
	const { username, kodyId } = shell
	const page = { username, kodyId }
	const mutationKey = collaboratorsMutationKey(actorKey, page)
	const captureSubmitter = useSubmitterScope()
	const [confirmed, setConfirmed] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const [teamId, setTeamId] = useState('')
	const [memberId, setMemberId] = useState('')
	const [teamPreset, setTeamPreset] = useState<PackageCollaboratorPreset>('use')
	const [memberPreset, setMemberPreset] =
		useState<PackageCollaboratorPreset>('use')
	const inFlight = useRef(false)
	const mutation = useMutation(
		collaboratorsMutationOptions(
			client,
			actorKey,
			page,
			async (input: CollaboratorsMutationInput) => {
				switch (input.change.intent) {
					case 'invite':
						return createPackageCollaboratorInvite({
							data: {
								...page,
								invitee: input.change.invitee,
								preset: input.change.preset,
							},
						})
					case 'revoke-invite':
						return revokePackageCollaboratorInvite({
							data: { ...page, inviteId: input.change.inviteId },
						})
					case 'grant':
						return grantPackageCollaborator({
							data: {
								...page,
								subjectType: input.change.subjectType,
								subjectId: input.change.subjectId,
								preset: input.change.preset,
							},
						})
					case 'revoke':
						return revokePackageCollaborator({
							data: { ...page, grantId: input.change.grantId },
						})
				}
			},
		),
	)
	const pending = useMutationState({
		filters: { mutationKey, exact: true, status: 'pending' },
		select: (entry) => entry.state.variables as CollaboratorsMutationInput,
	})
	const busy = pending.at(-1)?.key ?? null

	async function postChange(
		key: string,
		change: PackageCollaboratorsChange,
		success: string,
	) {
		if (inFlight.current || client.isMutating({ mutationKey, exact: true }))
			return null
		const isCurrent = captureSubmitter()
		inFlight.current = true
		setMessage(null)
		try {
			const result = await mutation.mutateAsync({ key, change })
			if (!isCurrent()) return null
			setMessage(success)
			setMessageTone('info')
			return result
		} catch (error) {
			if (!isCurrent()) return null
			setMessage(
				error instanceof Error ? error.message : 'Kody could not save that.',
			)
			setMessageTone('error')
			return null
		} finally {
			inFlight.current = false
		}
	}
	async function changePreset(
		collaborator: PackageCollaboratorView,
		preset: PackageCollaboratorPreset,
		select: HTMLSelectElement,
	) {
		if (preset === collaborator.preset) return
		await postChange(
			`preset:${collaborator.grantId}`,
			{
				intent: 'grant',
				subjectType: collaborator.subjectType,
				subjectId: collaborator.subjectId,
				preset,
			},
			`${collaboratorName(collaborator)} can now ${packageCollaboratorPresetLabel(preset).toLowerCase()} this package.`,
		)
		void select
	}

	async function addTeam(
		event: FormEvent<HTMLFormElement>,
		view: PackageCollaboratorsView,
	) {
		event.preventDefault()
		const team = view.options.teams.find((option) => option.id === teamId)
		if (!team) return
		const accepted = await postChange(
			'add-team',
			{
				intent: 'grant',
				subjectType: 'team',
				subjectId: team.id,
				preset: teamPreset,
			},
			`Added ${team.name}.`,
		)
		if (accepted) setTeamId('')
	}

	async function addMember(
		event: FormEvent<HTMLFormElement>,
		view: PackageCollaboratorsView,
	) {
		event.preventDefault()
		const member = view.options.members.find(
			(option) => option.userId === memberId,
		)
		if (!member) return
		const accepted = await postChange(
			'add-member',
			{
				intent: 'grant',
				subjectType: 'user',
				subjectId: member.userId,
				preset: memberPreset,
			},
			`Added ${member.username ? `@${member.username}` : 'that member'}.`,
		)
		if (accepted) setMemberId('')
	}

	function renderCollaborator(collaborator: PackageCollaboratorView) {
		const checkKey = collaborator.grantId
		const name = collaboratorName(collaborator)
		return (
			<li
				key={collaborator.grantId}
				data-testid="package-collaborator"
				data-subject={collaborator.subjectId}
				css={rowCss}
			>
				{collaborator.subjectType === 'team' ? (
					<span aria-hidden="true" css={iconWellCss}>
						{renderIcon('users', { size: '1.25rem' })}
					</span>
				) : (
					<UserAvatar
						displayName={name}
						avatarUrl={collaborator.avatarUrl}
						size={44}
						variant="well"
					/>
				)}
				<span css={rowTextCss}>
					<span css={rowNameCss}>{name}</span>
					<span css={rowDetailCss}>{collaboratorDetail(collaborator)}</span>
				</span>
				<span css={rowActionsCss}>
					{collaborator.kind === 'outside' ? (
						<span css={rowDetailCss}>
							{collaborator.preset
								? packageCollaboratorPresetLabel(collaborator.preset)
								: `Custom (${collaborator.permissions.length} permissions)`}
						</span>
					) : (
						<select
							aria-label={`Access for ${name}`}
							value={collaborator.preset ?? ''}
							disabled={busy !== null}
							css={selectCss}
							onChange={(event) => {
								const preset = readPreset(event)
								if (!preset) return
								void changePreset(
									collaborator,
									preset,
									event.currentTarget as HTMLSelectElement,
								)
							}}
						>
							{collaborator.preset === null ? (
								<option value="" disabled>
									Custom ({collaborator.permissions.length} permissions)
								</option>
							) : null}
							{renderPresetOptions(collaborator.preset)}
						</select>
					)}
					<button
						type="button"
						disabled={busy !== null}
						css={getDangerPillCss({ size: 'sm' })}
						onBlur={() => setConfirmed(null)}
						onClick={() => {
							if (confirmed !== checkKey) {
								setConfirmed(checkKey)
								return
							}
							setConfirmed(null)
							void postChange(
								`revoke:${collaborator.grantId}`,
								{ intent: 'revoke', grantId: collaborator.grantId },
								`Removed ${name}.`,
							)
						}}
					>
						{renderIcon('user-cross', { size: '1.05rem' })}
						{confirmed === checkKey ? 'Confirm remove' : 'Remove'}
					</button>
				</span>
			</li>
		)
	}

	function renderPresetField(input: {
		label: string
		value: PackageCollaboratorPreset
		onChange: (preset: PackageCollaboratorPreset) => void
	}) {
		return (
			<label css={accountFieldCss}>
				<span css={accountFieldLabelCss}>Access</span>
				<select
					aria-label={input.label}
					value={input.value}
					css={selectCss}
					onChange={(event) => {
						const preset = readPreset(event)
						if (!preset) return
						input.onChange(preset)
					}}
				>
					{renderPresetOptions(input.value)}
				</select>
				<p css={accountFieldNoteCss}>
					{packageCollaboratorPresetDescription(input.value)}.
				</p>
			</label>
		)
	}

	function renderAddTeam(view: PackageCollaboratorsView) {
		const teamsHref = routes.orgTeams.href({ orgSlug: view.org.slug })
		return (
			<AccountManagementPanel title="Add a team">
				{view.options.teams.length === 0 ? (
					<p css={mutedCopyCss}>
						Every team in this organization already has access, or there are no
						teams yet. <SiteLink href={teamsHref}>Manage teams</SiteLink>.
					</p>
				) : (
					<form
						data-testid="package-collaborators-add-team"
						css={formCss}
						onSubmit={(event) => void addTeam(event, view)}
					>
						<label css={accountFieldCss}>
							<span css={accountFieldLabelCss}>Team</span>
							<select
								aria-label="Team"
								value={teamId}
								required
								css={selectCss}
								onChange={(event) => {
									setTeamId((event.currentTarget as HTMLSelectElement).value)
								}}
							>
								<option value="">Choose a team</option>
								{view.options.teams.map((team) => (
									<option key={team.id} value={team.id}>
										{team.name} ({team.memberCount}{' '}
										{team.memberCount === 1 ? 'member' : 'members'})
									</option>
								))}
							</select>
						</label>
						{renderPresetField({
							label: 'Access for the team',
							value: teamPreset,
							onChange: (preset) => {
								setTeamPreset(preset)
							},
						})}
						<div css={accountActionsCss}>
							<button
								type="submit"
								disabled={busy !== null || teamId === ''}
								css={getPillButtonCss({ size: 'sm' })}
							>
								{renderIcon('plus', { size: '1.05rem' })}
								{busy === 'add-team' ? 'Adding…' : 'Add team'}
							</button>
						</div>
					</form>
				)}
			</AccountManagementPanel>
		)
	}

	function renderAddMember(view: PackageCollaboratorsView) {
		return (
			<AccountManagementPanel title="Add an org member">
				{view.options.members.length === 0 ? (
					<p css={mutedCopyCss}>
						No members left to add. Owners already have full access.
					</p>
				) : (
					<form
						data-testid="package-collaborators-add-member"
						css={formCss}
						onSubmit={(event) => void addMember(event, view)}
					>
						<label css={accountFieldCss}>
							<span css={accountFieldLabelCss}>Member</span>
							<select
								aria-label="Member"
								value={memberId}
								required
								css={selectCss}
								onChange={(event) => {
									setMemberId((event.currentTarget as HTMLSelectElement).value)
								}}
							>
								<option value="">Choose a member</option>
								{view.options.members.map((member) => (
									<option key={member.userId} value={member.userId}>
										{member.username ? `@${member.username}` : member.userId}
										{member.displayName ? ` (${member.displayName})` : ''}
									</option>
								))}
							</select>
						</label>
						{renderPresetField({
							label: 'Access for the member',
							value: memberPreset,
							onChange: (preset) => {
								setMemberPreset(preset)
							},
						})}
						<div css={accountActionsCss}>
							<button
								type="submit"
								disabled={busy !== null || memberId === ''}
								css={getPillButtonCss({ size: 'sm' })}
							>
								{renderIcon('plus', { size: '1.05rem' })}
								{busy === 'add-member' ? 'Adding…' : 'Add member'}
							</button>
						</div>
					</form>
				)}
			</AccountManagementPanel>
		)
	}

	return (
		<article
			css={detailArticleCss}
			data-testid="package-collaborators"
			aria-busy={busy !== null || undefined}
		>
			{renderPackageRepoChrome({
				username,
				kodyId,
				isPrivate: shell?.isPrivate ?? false,
				isListed: shell?.isListed ?? false,
				viewerIsOwner: true,
				viewerCanManage: shell?.viewerCanManage ?? false,
				viewerCanManageAccess: true,
				active: 'collaborators',
				filesHref: getPackageTreeHref({
					username,
					kodyId,
					listingId: shell?.listingId ?? null,
					ref: shell?.defaultBranch || fallbackDefaultBranchName,
				}),
				description: shell?.description ?? '',
				ownerProfilePublic: shell?.ownerProfilePublic ?? true,
				iconUrl: resolvePackageListIconUrl({
					username,
					kodyId,
					listingId: shell?.listingId ?? null,
					listingIconCommit: null,
					publishedCommit: shell?.publishedCommit ?? null,
				}),
				iconName: kodyId,
			})}

			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}
			{view ? (
				<>
					<AccountManagementPanel
						title="Who has access"
						description={
							view.org.personal
								? 'You always have full access to your own packages. People you invite show up here once they accept.'
								: 'Organization owners always have full access.'
						}
					>
						{view.collaborators.length === 0 ? (
							<p css={mutedCopyCss} data-testid="package-collaborators-empty">
								Nobody else has been given access to this package yet.
							</p>
						) : (
							<ul css={listCss} data-testid="package-collaborators-list">
								{view.collaborators.map(renderCollaborator)}
							</ul>
						)}
					</AccountManagementPanel>
					{view.org.personal ? null : renderAddTeam(view)}
					{view.org.personal ? null : renderAddMember(view)}
					{view.org.personal ? (
						<PackageCollaboratorInvites
							key={`${actorKey}/${username}/${kodyId}`}
							view={view}
							busyKey={busy}
							postChange={postChange}
						/>
					) : null}
					<PackageInviteLinksPanel
						username={username}
						kodyId={kodyId}
						orgSlug={view.org.slug}
						personal={view.org.personal}
						actorKey={actorKey}
					/>
				</>
			) : null}
		</article>
	)
}
