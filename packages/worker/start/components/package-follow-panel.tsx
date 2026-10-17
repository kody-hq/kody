/** @jsxImportSource @emotion/react */
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
	isNotFound,
	useLocation,
	useRouteContext,
} from '@tanstack/react-router'
import { followTarget, unfollowTarget } from '#start/server/follows'
import { packageFollowQuery, followMutationOptions } from '../follows-query.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { SiteLink } from './site-link.tsx'
import { PackageFollowContext } from './package-follow-context.ts'
import {
	describeFollowEvents,
	describePausedFollow,
	followDeliveryNote,
	followEventOptions,
	followEventsToSubmit,
	initialFollowEventChoice,
} from '#client/routes/follows-shared.ts'
import {
	followSkipReasonCopy,
	normalizeFollowEvents,
	type FollowEvent,
	type PackageFollowStatePayload,
} from '#universal/follows.ts'
import {
	type PackageRepoFollowAction,
	PACKAGE_FOLLOW_PANEL_ID,
} from '#universal/package-repo-actions.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { renderIcon } from './icon.tsx'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export function PackageFollowProvider(props: {
	username: string
	kodyId: string
	follow: PackageRepoFollowAction | null
	children: ReactNode
}) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	return (
		<FollowProvider
			key={`${actorKey}:${props.username}:${props.kodyId}`}
			{...props}
		/>
	)
}
export function PackageFollowPanel() {
	return useContext(PackageFollowContext)?.panel ?? null
}
function FollowProvider({
	username,
	kodyId,
	follow,
	children,
}: {
	username: string
	kodyId: string
	follow: PackageRepoFollowAction | null
	children: ReactNode
}) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	const hash = useLocation({ select: (location) => location.hash })
	const capture = useSubmitterScope()
	const client = useQueryClient()
	const [panelChoice, setPanelChoice] = useState<{
		hash: string
		open: boolean
	} | null>(null)
	const open =
		panelChoice?.hash === hash
			? panelChoice.open
			: hash === 'follow' && Boolean(follow?.loggedIn)
	function setOpen(value: boolean | ((previous: boolean) => boolean)) {
		setPanelChoice({
			hash,
			open: typeof value === 'function' ? value(open) : value,
		})
	}
	const panelRef = useRef<HTMLElement>(null)
	const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
	const [draft, setDraft] = useState<{
		slug: string
		events: FollowEvent[]
	} | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const [confirmed, setConfirmed] = useState(false)
	const read = useQuery({
		...packageFollowQuery(actorKey, { username, kodyId, kind: follow?.kind }),
		enabled: open && Boolean(follow?.loggedIn),
		retry: false,
	})
	const state = read.data
	const workspace =
		state?.workspaces.find((workspace) => workspace.slug === selectedSlug) ??
		state?.workspaces.find((workspace) => workspace.follow) ??
		state?.workspaces[0]
	const chosenEvents =
		state && workspace
			? draft && draft.slug === workspace.slug
				? draft.events
				: initialFollowEventChoice(state, workspace.follow)
			: []
	function setChosenEvents(update: (previous: FollowEvent[]) => FollowEvent[]) {
		if (workspace)
			setDraft({ slug: workspace.slug, events: update(chosenEvents) })
	}
	function selectWorkspace(slug: string) {
		setSelectedSlug(slug)
		setDraft(null)
	}
	const following = state
		? state.workspaces.some((workspace) => workspace.follow !== null)
		: (follow?.following ?? false)
	const followMutation = useMutation(
		followMutationOptions(
			client,
			actorKey,
			(input: {
				orgSlug: string
				name: string
				kind: 'package' | 'repo'
				events?: FollowEvent[]
			}) => followTarget({ data: input }),
		),
	)
	const unfollowMutation = useMutation(
		followMutationOptions(
			client,
			actorKey,
			(input: { orgSlug: string; name: string; kind: 'package' | 'repo' }) =>
				unfollowTarget({ data: input }),
		),
	)
	const submitting = followMutation.isPending || unfollowMutation.isPending
	useEffect(() => {
		if (open) panelRef.current?.focus()
	}, [open])
	function toggle() {
		if (!open && read.isError) void read.refetch()
		setOpen((previous) => !previous)
	}
	async function submit(intent: 'follow' | 'unfollow') {
		if (!state || !workspace || submitting) return
		const isCurrent = capture()
		const submittedWorkspace = workspace
		const wasFollowing = workspace.follow !== null
		const { events } = followEventsToSubmit(
			state,
			workspace.follow,
			chosenEvents,
		)
		const input = {
			orgSlug: workspace.slug,
			name: state.target.name,
			kind: state.target.kind,
		}
		setMessage(null)
		try {
			const payload =
				intent === 'follow'
					? await followMutation.mutateAsync({
							...input,
							...(events ? { events } : {}),
						})
					: await unfollowMutation.mutateAsync(input)
			if (!isCurrent()) return
			setDraft({
				slug: submittedWorkspace.slug,
				events: initialFollowEventChoice(state, payload.follow),
			})
			setConfirmed(false)
			setMessageTone(payload.follow?.status === 'paused' ? 'error' : 'info')
			setMessage(
				intent === 'unfollow'
					? `Unfollowed in ${workspaceLabel(submittedWorkspace)}.`
					: payload.follow?.status === 'paused'
						? (describePausedFollow(payload.follow) ?? 'This follow is paused.')
						: `${wasFollowing ? 'Saved.' : 'Following.'} ${describeFollowEvents(payload.follow?.events ?? [])} go to ${workspaceLabel(submittedWorkspace)}.`,
			)
		} catch (error) {
			if (isCurrent()) {
				setMessageTone('error')
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to update this follow. Try again.',
				)
			}
		}
	}
	const panel =
		open && follow?.loggedIn ? (
			<section
				ref={panelRef}
				id={PACKAGE_FOLLOW_PANEL_ID}
				tabIndex={-1}
				aria-labelledby="package-follow-title"
				data-testid="package-follow-panel"
				css={panelCss}
			>
				<div css={panelHeadCss}>
					<h2 id="package-follow-title" css={panelTitleCss}>
						{state ? `Follow ${state.target.name}` : 'Follow'}
					</h2>
					<button
						type="button"
						aria-label="Close follow options"
						data-testid="package-follow-close"
						css={getGhostButtonCss({ size: 'sm' })}
						onClick={() => setOpen(false)}
					>
						{renderIcon('close', { size: '1.05rem' })}
					</button>
				</div>
				{read.isPending && !state ? (
					<p role="status" css={mutedCss}>
						Loading follow options…
					</p>
				) : null}
				{read.isError ? (
					<p role="alert" css={errorCss}>
						{isNotFound(read.error)
							? 'You can’t follow this. You need access to it first.'
							: 'Unable to load follow options. Close and try again.'}
					</p>
				) : null}
				{state && workspace ? renderPanelBody({ state, workspace }) : null}
				{state && !workspace ? (
					<p css={mutedCss}>
						You need to be a member of a workspace to follow this.
					</p>
				) : null}
			</section>
		) : null
	return (
		<PackageFollowContext.Provider value={{ open, following, toggle, panel }}>
			{children}
		</PackageFollowContext.Provider>
	)
	function renderPanelBody(input: {
		state: PackageFollowStatePayload
		workspace: PackageFollowStatePayload['workspaces'][number]
	}) {
		const { state: current, workspace } = input
		const follow = workspace.follow
		const eventOptions = followEventOptions(current)
		const offerable = eventOptions.filter((option) => !option.disabledReason)
		const blocked = offerable.length === 0
		const paused = follow ? describePausedFollow(follow) : null
		const skipped = follow
			? followSkipReasonCopy(follow.lastDeliverySkipReason)
			: null
		const submission = followEventsToSubmit(current, follow, chosenEvents)
		const nothingChosen = !(submission.events ?? chosenEvents).some((event) =>
			offerable.some((option) => option.event === event),
		)
		const unchanged =
			follow?.status === 'active' && submission.events === undefined
		const primaryLabel = !follow
			? 'Follow'
			: follow.status === 'paused'
				? 'Resume'
				: 'Save'
		return (
			<>
				{current.workspaces.length > 1 ? (
					<label css={fieldCss}>
						<span css={labelCss}>Follow in</span>
						<select
							data-testid="package-follow-workspace"
							disabled={submitting}
							css={getSelectCss()}
							value={workspace.slug}
							onChange={(event) => {
								selectWorkspace(event.currentTarget.value)
								setMessage(null)
								setConfirmed(false)
							}}
						>
							{current.workspaces.map((option) => (
								<option key={option.slug} value={option.slug}>
									{workspaceOptionLabel(option)}
									{option.follow ? ' (following)' : ''}
								</option>
							))}
						</select>
					</label>
				) : (
					<p css={mutedCss}>Events go to {workspaceLabel(workspace)}.</p>
				)}
				<p data-testid="package-follow-status" css={statusCss}>
					{follow
						? follow.status === 'paused'
							? paused
							: `Following. ${describeFollowEvents(follow.events)} go to this workspace.`
						: 'Not following in this workspace.'}
				</p>
				{skipped ? <p css={statusCss}>{skipped}</p> : null}
				<fieldset css={fieldsetCss}>
					<legend css={labelCss}>Send events for</legend>
					{eventOptions.map((option) => {
						const disabled = Boolean(option.disabledReason)
						const checked =
							chosenEvents.includes(option.event) &&
							(!disabled || submission.events === undefined)
						return (
							<label
								key={option.event}
								data-testid={`package-follow-event-${option.event}`}
								css={optionCss}
							>
								<input
									type="checkbox"
									name="events"
									value={option.event}
									checked={checked}
									disabled={disabled || submitting}
									onChange={(event) => {
										const checked = event.currentTarget.checked
										setChosenEvents((previous) =>
											checked
												? normalizeFollowEvents([...previous, option.event])
												: previous.filter((item) => item !== option.event),
										)
									}}
								/>
								<span css={optionTextCss}>
									<span css={optionLabelCss}>{option.label}</span>
									<span css={mutedSmallCss}>{option.description}</span>
									{option.disabledReason ? (
										<span
											data-testid={`package-follow-event-${option.event}-gated`}
											css={gatedCss}
										>
											{option.disabledReason}
										</span>
									) : null}
								</span>
							</label>
						)
					})}
				</fieldset>
				{blocked && !follow ? (
					<p data-testid="package-follow-blocked" css={statusCss}>
						{current.target.kind === 'repo'
							? 'Repositories only send pushes, so you can’t follow this one until you have read access.'
							: 'There is nothing you can follow here yet.'}
					</p>
				) : null}
				<div css={actionsCss}>
					<button
						type="button"
						data-testid="package-follow-submit"
						disabled={
							submitting || blocked || nothingChosen || Boolean(unchanged)
						}
						css={getPillButtonCss({ size: 'sm' })}
						onClick={() => void submit('follow')}
					>
						{renderIcon(follow ? 'check' : 'eye', { size: '1.05rem' })}
						{submitting ? 'Saving…' : primaryLabel}
					</button>
					{follow ? (
						<button
							type="button"
							data-testid="package-follow-unfollow"
							disabled={submitting}
							css={getDangerPillCss({ size: 'sm' })}
							onBlur={() => setConfirmed(false)}
							onClick={() =>
								confirmed ? void submit('unfollow') : setConfirmed(true)
							}
						>
							{renderIcon('close', { size: '1.05rem' })}
							{confirmed ? 'Confirm unfollow' : 'Unfollow'}
						</button>
					) : null}
				</div>
				{nothingChosen && !blocked ? (
					<p data-testid="package-follow-choose" css={mutedSmallCss}>
						{chosenEvents.length > 0
							? 'Nothing checked here can reach this workspace without read access. Choose another event, or unfollow.'
							: 'Choose at least one. To stop everything, unfollow.'}
					</p>
				) : null}
				{submission.dropsGated && !nothingChosen ? (
					<p data-testid="package-follow-drops-gated" css={gatedCss}>
						Saving turns off pushes for this workspace. Pushes need read access,
						which you don’t have.
					</p>
				) : null}
				{message ? (
					<p
						data-testid="package-follow-message"
						role={messageTone === 'error' ? 'alert' : 'status'}
						css={messageTone === 'error' ? errorCss : statusCss}
					>
						{message}
					</p>
				) : null}
				<p css={mutedSmallCss}>
					{followDeliveryNote}{' '}
					<SiteLink
						href={orgResourcePath(workspace.slug, 'follows')}
						data-testid="package-follow-manage"
					>
						Manage follows
					</SiteLink>
				</p>
			</>
		)
	}
}

type WorkspaceName = {
	slug: string
	displayName: string | null
	personal: boolean
}

function workspaceLabel(workspace: WorkspaceName) {
	if (workspace.personal) return 'your personal workspace'
	return workspace.displayName?.trim() || workspace.slug
}

function workspaceOptionLabel(workspace: WorkspaceName) {
	if (workspace.personal) return 'Personal workspace'
	return workspaceLabel(workspace)
}

const panelCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	marginBlock: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	'&:focus': { outline: 'none' },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const panelHeadCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.md,
}

const panelTitleCss = {
	margin: 0,
	fontSize: '1.05rem',
	fontWeight: 700,
	letterSpacing: '-0.01em',
	overflowWrap: 'anywhere' as const,
}

const mutedCss = { margin: 0, color: colors.textMuted, lineHeight: 1.5 }

const mutedSmallCss = {
	...mutedCss,
	fontSize: typography.fontSize.sm,
}

const statusCss = { margin: 0, color: colors.text, lineHeight: 1.5 }

const errorCss = { margin: 0, color: colors.error, lineHeight: 1.5 }

const gatedCss = {
	fontSize: typography.fontSize.sm,
	color: colors.warningText,
	lineHeight: 1.45,
}

const fieldCss = { display: 'grid', gap: spacing.xs, maxWidth: '24rem' }

const labelCss = {
	color: colors.text,
	fontWeight: typography.fontWeight.medium,
	fontSize: typography.fontSize.sm,
	padding: 0,
}

const fieldsetCss = {
	display: 'grid',
	gap: spacing.sm,
	margin: 0,
	padding: 0,
	border: 'none',
	minWidth: 0,
}

const optionCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.sm,
	cursor: 'pointer',
	'& input': { marginTop: '0.25rem' },
	'&:has(input:disabled)': { cursor: 'not-allowed' },
}

const optionTextCss = { display: 'grid', gap: '0.1rem', minWidth: 0 }

const optionLabelCss = { fontWeight: 650 }

const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}
