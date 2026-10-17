/** @jsxImportSource @emotion/react */
import {
	createConnectionProfile,
	updateConnectionProfile,
	deleteConnectionProfile,
} from '#start/server/account-mutations'
import { connectionProfileNameMaxLength } from '#universal/connection-profiles/names.ts'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
	type AccountConnectionProfileView,
} from '#universal/loader-data.ts'
import {
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { type CSSObject } from '@emotion/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { Combobox, type ComboboxOption } from '../components/combobox.tsx'
import { connectionProfileMutationOptions } from '../connection-profile-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { accountInputCss } from './account-management-components.tsx'
import { CopyCard } from './onboarding-mcp-client-cards.tsx'
type PackageOption = NonNullable<
	AccountConnectedAgentsLoaderData['connectionProfilePackageOptions']
>[number]
const grantActions = ['read', 'execute'] as const
type GrantAction = (typeof grantActions)[number]
type DraftGrant = {
	resourceId: string
	read: boolean
	execute: boolean
}
type EditDraft = {
	profileId: string
	grants: Array<DraftGrant>
}
/** Which form a mutation error belongs to: the create form or one profile. */
type MessageTarget =
	| {
			kind: 'create'
	  }
	| {
			kind: 'profile'
			profileId: string
	  }
/**
 * Named connection profiles on the Agents page (`/@slug/-/agents`). A profile lists only
 * the packages it grants, each with read/execute toggles, and adds more
 * through a package combobox — the same shape as a secret's allowed
 * packages — so an account with hundreds of packages does not render one
 * checkbox per package.
 */
export function ConnectionProfiles({
	payload,
	agents,
}: {
	payload: AccountConnectedAgentsLoaderData
	agents: Array<AccountConnectedAgentListItem>
	currentHref: string
}) {
	const enabled = payload.connectionProfilesEnabled === true
	const profiles = payload.connectionProfiles ?? []
	const packageOptions = payload.connectionProfilePackageOptions ?? []
	const [createName, setCreateName] = useState('')
	const [createGrants, setCreateGrants] = useState<Array<DraftGrant>>([])
	const [editDraft, setEditDraft] = useState<EditDraft | null>(null)
	const [message, setMessage] = useState<{
		target: MessageTarget
		text: string
	} | null>(null)
	const queryClient = useQueryClient()
	const { actorKey, orgSlug } = useMatchedPageScope()
	const capture = useSubmitterScope()
	const options = connectionProfileMutationOptions(
		queryClient,
		actorKey,
		orgSlug,
	)
	const create = useMutation({
		...options,
		mutationFn: createConnectionProfile,
	})
	const update = useMutation({
		...options,
		mutationFn: updateConnectionProfile,
	})
	const remove = useMutation({
		...options,
		mutationFn: deleteConnectionProfile,
	})
	const busy = create.isPending || update.isPending || remove.isPending

	async function postMutation(
		write: () => Promise<unknown>,
		target: MessageTarget,
	) {
		if (busy) return false
		const isCurrent = capture()
		setMessage(null)
		try {
			await write()
			if (!isCurrent()) return false
			return true
		} catch (error) {
			if (!isCurrent()) return false
			setMessage({
				target,
				text:
					error instanceof Error ? error.message : 'Unable to update profile.',
			})
			return false
		}
	}
	async function createProfile() {
		const saved = await postMutation(
			() =>
				create.mutateAsync({
					data: {
						orgSlug: orgSlug ?? undefined,
						name: createName,
						grants: toGrantPayload(createGrants),
					},
				}),
			{ kind: 'create' },
		)
		if (saved) {
			setCreateName('')
			setCreateGrants([])
		}
	}
	async function saveEdit() {
		if (!editDraft) return
		const { profileId } = editDraft
		const knownPackageIds = new Set(packageOptions.map((pkg) => pkg.id))
		// The update re-checks ownership of every grant, so a package deleted
		// since the profile was saved has to leave the payload.
		const grants = editDraft.grants.filter((grant) =>
			knownPackageIds.has(grant.resourceId),
		)
		const saved = await postMutation(
			() =>
				update.mutateAsync({
					data: {
						orgSlug: orgSlug ?? undefined,
						profileId,
						grants: toGrantPayload(grants),
					},
				}),
			{ kind: 'profile', profileId },
		)
		if (saved) {
			setEditDraft(null)
		}
	}
	function startEdit(profile: AccountConnectionProfileView) {
		setEditDraft({
			profileId: profile.id,
			grants: profile.grants.map((grant) => ({
				resourceId: grant.resourceId,
				read: grant.actions.includes('read'),
				execute: grant.actions.includes('execute'),
			})),
		})
		setMessage(null)
	}
	function cancelEdit() {
		setEditDraft(null)
		setMessage(null)
	}
	function grantsEditorHandlers(
		read: () => Array<DraftGrant>,
		write: (next: Array<DraftGrant>) => void,
	) {
		return {
			onAdd: (packageId: string) => {
				if (read().some((grant) => grant.resourceId === packageId)) return
				write([...read(), { resourceId: packageId, read: true, execute: true }])
			},
			onRemove: (packageId: string) => {
				write(read().filter((grant) => grant.resourceId !== packageId))
			},
			onToggleAction: (
				packageId: string,
				action: GrantAction,
				value: boolean,
			) => {
				write(
					read().map((grant) =>
						grant.resourceId === packageId
							? { ...grant, [action]: value }
							: grant,
					),
				)
			},
		}
	}
	const createHandlers = grantsEditorHandlers(
		() => createGrants,
		(next) => {
			setCreateGrants(next)
		},
	)
	const editHandlers = grantsEditorHandlers(
		() => editDraft?.grants ?? [],
		(next) => {
			if (editDraft) setEditDraft({ ...editDraft, grants: next })
		},
	)
	function messageFor(target: MessageTarget) {
		if (!message) return null
		if (message.target.kind !== target.kind) return null
		if (
			message.target.kind === 'profile' &&
			target.kind === 'profile' &&
			message.target.profileId !== target.profileId
		) {
			return null
		}
		return <p css={messageCss}>{message.text}</p>
	}
	function render(input: {
		agents: Array<AccountConnectedAgentListItem>
	}): ReactNode {
		if (!enabled) return null
		const packagesById = new Map(packageOptions.map((pkg) => [pkg.id, pkg]))
		const comboboxOptions = toComboboxOptions(packageOptions)
		const unlimitedAgents = input.agents.filter(
			(agent) => !agent.connectionProfileName,
		)
		return (
			<section data-testid="connection-profiles" css={sectionCss}>
				<div css={blockCss}>
					<h2 css={titleCss}>Unlimited</h2>
					<p css={copyCss}>
						The default connection. No profile query param — the agent gets full
						access to this account (today’s behavior). Connections using
						Unlimited:
					</p>
					{renderAgentList(unlimitedAgents, 'No unlimited connections yet.')}
				</div>

				<div css={blockCss}>
					<h2 css={titleCss}>Profiles</h2>
					<p css={copyCss}>
						A named profile only grants the packages you add (read and/or
						execute). Paste the profile MCP URL into an agent; OAuth is
						unchanged. Profile names are at most{' '}
						{connectionProfileNameMaxLength} characters. “Unlimited” is
						reserved.
					</p>

					{profiles.length === 0 ? (
						<p css={mutedCss}>No profiles yet.</p>
					) : (
						<ul css={profileListCss}>
							{profiles.map((profile) => {
								const editing =
									editDraft?.profileId === profile.id ? editDraft : null
								return (
									<li
										key={profile.id}
										data-testid={`connection-profile-${profile.id}`}
										css={cardCss}
									>
										<div css={profileHeaderCss}>
											<strong>{profile.name}</strong>
											<div css={buttonRowCss}>
												{editing ? null : (
													<button
														type="button"
														disabled={busy || editDraft !== null}
														data-testid={`connection-profile-edit-${profile.id}`}
														aria-label={`Edit packages for ${profile.name}`}
														onClick={() => startEdit(profile)}
														css={ghostButtonCss}
													>
														Edit packages
													</button>
												)}
												<button
													type="button"
													disabled={busy}
													data-testid={`connection-profile-delete-${profile.id}`}
													aria-label={`Delete profile ${profile.name}`}
													onClick={() => {
														void postMutation(
															() =>
																remove.mutateAsync({
																	data: {
																		orgSlug: orgSlug ?? undefined,
																		profileId: profile.id,
																	},
																}),
															{ kind: 'profile', profileId: profile.id },
														)
													}}
													css={ghostButtonCss}
												>
													Delete
												</button>
											</div>
										</div>
										{profile.mcpServerUrl ? (
											<CopyCard
												label="MCP URL"
												value={profile.mcpServerUrl}
												copyLabel="Copy MCP URL"
												variant="pill"
											/>
										) : null}
										{editing ? (
											<form
												data-testid={`connection-profile-edit-form-${profile.id}`}
												onSubmit={(event) => {
													event.preventDefault()
													void saveEdit()
												}}
												css={formCss}
											>
												{renderGrantsEditor({
													idPrefix: `connection-profile-${profile.id}`,
													grants: editing.grants,
													packagesById,
													comboboxOptions,
													disabled: busy,
													...editHandlers,
												})}
												{messageFor({ kind: 'profile', profileId: profile.id })}
												<div css={buttonRowCss}>
													<button
														type="submit"
														disabled={busy}
														css={pillButtonCss}
													>
														Save packages
													</button>
													<button
														type="button"
														disabled={busy}
														onClick={cancelEdit}
														css={ghostButtonCss}
													>
														Cancel
													</button>
												</div>
											</form>
										) : (
											<>
												{renderGrantSummary(profile, packagesById)}
												{messageFor({ kind: 'profile', profileId: profile.id })}
											</>
										)}
										{renderAgentList(
											input.agents.filter(
												(agent) => agent.connectionProfileName === profile.name,
											),
											'No agents connected with this profile.',
										)}
									</li>
								)
							})}
						</ul>
					)}

					<form
						data-testid="connection-profile-create"
						onSubmit={(event) => {
							event.preventDefault()
							void createProfile()
						}}
						css={[cardCss, formCss]}
					>
						<h3 css={subtitleCss}>Add profile</h3>
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Name</span>
							<input
								data-field-ring
								type="text"
								name="name"
								maxLength={connectionProfileNameMaxLength}
								value={createName}
								disabled={busy}
								onInput={(event) => {
									setCreateName(event.currentTarget.value)
								}}
								css={accountInputCss}
							/>
						</label>
						{renderGrantsEditor({
							idPrefix: 'connection-profile-create',
							grants: createGrants,
							packagesById,
							comboboxOptions,
							disabled: busy,
							...createHandlers,
						})}
						{messageFor({ kind: 'create' })}
						<div>
							<button type="submit" disabled={busy} css={pillButtonCss}>
								Create profile
							</button>
						</div>
					</form>
				</div>
			</section>
		)
	}
	return render({ agents })
}
function toGrantPayload(grants: Array<DraftGrant>) {
	return grants
		.filter((grant) => grant.read || grant.execute)
		.map((grant) => ({
			resourceType: 'package' as const,
			resourceId: grant.resourceId,
			actions: [
				...(grant.read ? (['read'] as const) : []),
				...(grant.execute ? (['execute'] as const) : []),
			],
		}))
}
function toComboboxOptions(
	packageOptions: Array<PackageOption>,
): Array<ComboboxOption> {
	return packageOptions
		.map((pkg) => ({
			id: pkg.id,
			label: pkg.kodyId,
			keywords: [pkg.name, pkg.id],
		}))
		.sort((left, right) => left.label.localeCompare(right.label))
}
function packageLabel(
	packageId: string,
	packagesById: ReadonlyMap<string, PackageOption>,
) {
	return packagesById.get(packageId)?.kodyId ?? 'Unknown package'
}
/** A deleted package keeps its id so several of them stay distinguishable. */
function renderPackageIdentity(
	packageId: string,
	packagesById: ReadonlyMap<string, PackageOption>,
) {
	return (
		<span css={packageIdentityCss}>
			{packageLabel(packageId, packagesById)}
			{packagesById.has(packageId) ? null : <code>{packageId}</code>}
		</span>
	)
}
function sortByPackageLabel<
	T extends {
		resourceId: string
	},
>(grants: ReadonlyArray<T>, packagesById: ReadonlyMap<string, PackageOption>) {
	return [...grants].sort((left, right) =>
		packageLabel(left.resourceId, packagesById).localeCompare(
			packageLabel(right.resourceId, packagesById),
		),
	)
}
function renderGrantSummary(
	profile: AccountConnectionProfileView,
	packagesById: ReadonlyMap<string, PackageOption>,
) {
	if (profile.grants.length === 0) {
		return (
			<p css={mutedCss}>No packages — this profile can see and run nothing.</p>
		)
	}
	return (
		<ul aria-label={`Packages granted to ${profile.name}`} css={grantListCss}>
			{sortByPackageLabel(profile.grants, packagesById).map((grant) => (
				<li key={grant.resourceId} css={grantSummaryRowCss}>
					{renderPackageIdentity(grant.resourceId, packagesById)}
					<span css={mutedCss}>
						{grantActions
							.filter((action) => grant.actions.includes(action))
							.join(' · ')}
					</span>
				</li>
			))}
		</ul>
	)
}
function renderGrantsEditor(input: {
	idPrefix: string
	grants: Array<DraftGrant>
	packagesById: ReadonlyMap<string, PackageOption>
	comboboxOptions: Array<ComboboxOption>
	disabled: boolean
	onAdd: (packageId: string) => void
	onRemove: (packageId: string) => void
	onToggleAction: (
		packageId: string,
		action: GrantAction,
		value: boolean,
	) => void
}) {
	const grantedIds = new Set(input.grants.map((grant) => grant.resourceId))
	const available = input.comboboxOptions.filter(
		(option) => !grantedIds.has(option.id),
	)
	return (
		<div css={editorCss}>
			<span css={fieldLabelCss}>Packages</span>
			{input.grants.length === 0 ? (
				<p css={mutedCss}>
					No packages yet — this profile can see and run nothing.
				</p>
			) : (
				<ul css={grantListCss}>
					{sortByPackageLabel(input.grants, input.packagesById).map((grant) => {
						const label = packageLabel(grant.resourceId, input.packagesById)
						const testId = `${input.idPrefix}-grant-${grant.resourceId}`
						if (!input.packagesById.has(grant.resourceId)) {
							return (
								<li
									key={grant.resourceId}
									data-testid={testId}
									css={grantEditRowCss}
								>
									{renderPackageIdentity(grant.resourceId, input.packagesById)}
									<span css={mutedCss}>Removed when you save</span>
								</li>
							)
						}
						return (
							<li
								key={grant.resourceId}
								data-testid={testId}
								css={grantEditRowCss}
							>
								{renderPackageIdentity(grant.resourceId, input.packagesById)}
								<div css={actionsRowCss}>
									{grantActions.map((action) => {
										const checked = grant[action]
										const otherChecked =
											action === 'read' ? grant.execute : grant.read
										return (
											<label key={action} css={actionLabelCss}>
												<input
													type="checkbox"
													checked={checked}
													// A granted package keeps at least one action;
													// Remove drops it entirely.
													disabled={
														input.disabled || (checked && !otherChecked)
													}
													aria-label={`${action} ${label}`}
													onChange={(event) => {
														input.onToggleAction(
															grant.resourceId,
															action,
															event.currentTarget.checked,
														)
													}}
												/>
												{action}
											</label>
										)
									})}
									<button
										type="button"
										disabled={input.disabled}
										aria-label={`Remove package ${label}`}
										onClick={() => input.onRemove(grant.resourceId)}
										css={ghostButtonCss}
									>
										Remove
									</button>
								</div>
							</li>
						)
					})}
				</ul>
			)}
			{input.comboboxOptions.length === 0 ? (
				<p css={mutedCss}>Save a package first to grant it here.</p>
			) : available.length === 0 ? (
				<p css={mutedCss}>Every saved package is already added.</p>
			) : (
				<Combobox
					key={`${input.idPrefix}-add:${[...grantedIds].join(',')}`}
					id={`${input.idPrefix}-add-package`}
					label="Add package"
					placeholder="Search saved packages"
					value=""
					options={available}
					disabled={input.disabled}
					onChange={input.onAdd}
				/>
			)}
		</div>
	)
}
function renderAgentList(
	agents: Array<AccountConnectedAgentListItem>,
	emptyText: string,
) {
	if (agents.length === 0) return <p css={mutedCss}>{emptyText}</p>
	return (
		<ul css={agentListCss}>
			{agents.map((agent) => (
				<li key={agent.clientId}>{agent.label}</li>
			))}
		</ul>
	)
}
const pillButtonCss: CSSObject = getPillButtonCss({ size: 'sm' })
const ghostButtonCss: CSSObject = getGhostButtonCss({ size: 'sm' })
const sectionCss: CSSObject = {
	display: 'grid',
	gap: spacing.xl,
	marginBlockStart: spacing.xl,
}
const blockCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
}
const titleCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.lg,
	fontWeight: typography.fontWeight.semibold,
}
const subtitleCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
}
const copyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '40rem',
}
const mutedCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
const agentListCss: CSSObject = {
	margin: 0,
	paddingInlineStart: spacing.lg,
	display: 'grid',
	gap: spacing.xs,
}
const profileListCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.lg,
}
const cardCss: CSSObject = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
}
const profileHeaderCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	flexWrap: 'wrap' as const,
	gap: spacing.md,
}
const buttonRowCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}
const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
}
const editorCss: CSSObject = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
}
const grantListCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}
const grantSummaryRowCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'baseline',
	justifyContent: 'space-between',
	gap: spacing.sm,
	fontSize: typography.fontSize.sm,
}
const grantEditRowCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'center',
	gap: spacing.sm,
	padding: spacing.sm,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
}
const packageIdentityCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
	fontWeight: typography.fontWeight.medium,
	overflowWrap: 'anywhere' as const,
	'& code': {
		color: colors.textMuted,
		fontWeight: typography.fontWeight.normal,
	},
}
const actionsRowCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.md,
	fontSize: typography.fontSize.sm,
}
const actionLabelCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
}
const messageCss: CSSObject = {
	margin: 0,
	color: colors.danger,
	fontSize: typography.fontSize.sm,
}
