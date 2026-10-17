/** @jsxImportSource @emotion/react */
import {
	useIsMutating,
	useMutation,
	useQueryClient,
} from '@tanstack/react-query'
import { useState } from 'react'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import {
	describeFollowEvents,
	describePausedFollow,
	followDeliveryNote,
	followPausedRetentionNote,
} from '#client/routes/follows-shared.ts'
import {
	followEventCopy,
	followSkipReasonCopy,
	type OrgFollowRow,
	type OrgFollowsLoaderData,
} from '#universal/follows.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	nativeDisclosureCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { resumeFollow, unfollowTarget } from '#start/server/follows'
import { followMutationOptions } from '../follows-query.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { renderIcon } from '../components/icon.tsx'
import { SiteLink } from '../components/site-link.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'

export function OrgFollowsPage({
	data,
	currentHref,
}: {
	data: OrgFollowsLoaderData
	currentHref: string
}) {
	const client = useQueryClient()
	const { actorKey } = useMatchedPageScope()
	const captureSubmitter = useSubmitterScope()
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const resume = useMutation(
		followMutationOptions(
			client,
			actorKey,
			(data: { orgSlug: string; id: string }) => resumeFollow({ data }),
		),
	)
	const unfollow = useMutation(
		followMutationOptions(
			client,
			actorKey,
			(data: { orgSlug: string; id: string }) => unfollowTarget({ data }),
		),
	)
	const mutationFilter = {
		mutationKey: ['follows', actorKey, 'write'],
		predicate: (mutation: { state: { variables?: unknown } }) => {
			const input = mutation.state.variables
			return Boolean(
				input &&
				typeof input === 'object' &&
				'orgSlug' in input &&
				input.orgSlug === data.orgSlug,
			)
		},
	}
	const busy = useIsMutating(mutationFilter) > 0
	function mutate(follow: OrgFollowRow, intent: 'unfollow' | 'resume') {
		if (client.isMutating(mutationFilter)) return
		const isCurrent = captureSubmitter()
		setMessage(null)
		const callbacks = {
			onError: (error: unknown) => {
				if (isCurrent())
					setMessage({
						text:
							error instanceof Error
								? error.message
								: 'Unable to update this follow.',
						tone: 'error',
					})
			},
		}
		if (intent === 'unfollow') {
			unfollow.mutate(
				{ orgSlug: data.orgSlug, id: follow.id },
				{
					...callbacks,
					onSuccess: () => {
						if (isCurrent())
							setMessage({ text: `Unfollowed ${follow.name}.`, tone: 'info' })
					},
				},
			)
		} else {
			resume.mutate(
				{ orgSlug: data.orgSlug, id: follow.id },
				{
					...callbacks,
					onSuccess: (accepted) => {
						if (!isCurrent()) return
						const active = accepted.follow?.status === 'active'
						setMessage({
							text: active
								? `Following ${follow.name} again.`
								: `${follow.name} is still paused.`,
							tone: active ? 'info' : 'error',
						})
					},
				},
			)
		}
	}
	return (
		<AccountManagementShell currentHref={currentHref}>
			<AccountPageHeader
				title="Follows"
				description="Packages and repositories this workspace follows. Their new versions and pushes arrive here as events."
				currentHref={currentHref}
			/>
			{message ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			<AccountManagementPanel title="Following" ariaLabel="Follows">
				{data.follows.length === 0 ? (
					<p css={mutedCopyCss} data-testid="org-follows-empty">
						Not following anything yet. Open a package or repository and choose
						Follow. Browse{' '}
						<SiteLink href={routes.community.href()}>Community</SiteLink> to
						find one.
					</p>
				) : (
					<ul css={listCss} data-testid="org-follows">
						{data.follows.map((follow) => (
							<FollowRow
								key={follow.id}
								follow={follow}
								busy={busy}
								onUnfollow={() => mutate(follow, 'unfollow')}
								onResume={() => mutate(follow, 'resume')}
							/>
						))}
					</ul>
				)}
				<p css={noteCss}>
					{followDeliveryNote} {followPausedRetentionNote}
				</p>
			</AccountManagementPanel>
		</AccountManagementShell>
	)
}

function FollowRow({
	follow,
	busy,
	onUnfollow,
	onResume,
}: {
	follow: OrgFollowRow
	busy: boolean
	onUnfollow(): void
	onResume(): void
}) {
	const [armed, setArmed] = useState(false)
	const paused = describePausedFollow(follow)
	const skipped = followSkipReasonCopy(follow.lastDeliverySkipReason)
	return (
		<li
			key={follow.id}
			data-testid="org-follow"
			data-follow-status={follow.status}
			css={rowItemCss}
		>
			<div css={rowCss}>
				<span aria-hidden="true" css={iconCss}>
					{renderIcon(follow.status === 'paused' ? 'pause' : 'eye', {
						size: '1.25rem',
					})}
				</span>
				<span css={rowTextCss}>
					<span css={rowNameLineCss}>
						{follow.href ? (
							<SiteLink href={follow.href} css={rowNameCss}>
								{follow.name}
							</SiteLink>
						) : (
							<span css={rowNameCss}>{follow.name}</span>
						)}
						<span
							data-testid="org-follow-status"
							css={follow.status === 'paused' ? pausedChipCss : activeChipCss}
						>
							{follow.status === 'paused' ? 'Paused' : 'Active'}
						</span>
					</span>
					<span css={rowDetailCss}>
						{follow.kind === 'repo' ? 'Repository' : 'Package'} ·{' '}
						{describeFollowEvents(follow.events)}
					</span>
					{paused ? (
						<span data-testid="org-follow-paused" css={rowWarningCss}>
							{paused}
							{follow.deleteAt ? (
								<>
									{' '}
									It will be deleted on {formatTimestampDate(
										follow.deleteAt,
									)}{' '}
									unless access comes back and you resume it.
								</>
							) : null}
						</span>
					) : null}
					{skipped ? (
						<span data-testid="org-follow-skipped" css={rowWarningCss}>
							{skipped}
						</span>
					) : null}
				</span>
				<span css={rowActionsCss}>
					{follow.status === 'paused' ? (
						<button
							type="button"
							data-testid="org-follow-resume"
							disabled={busy}
							css={getGhostButtonCss({ size: 'sm' })}
							onClick={onResume}
						>
							{renderIcon('play', { size: '1.05rem' })}
							Resume
						</button>
					) : null}
					<button
						type="button"
						data-testid="org-follow-unfollow"
						disabled={busy}
						css={getDangerPillCss({ size: 'sm' })}
						onBlur={() => setArmed(false)}
						onClick={() => {
							if (!armed) {
								setArmed(true)
								return
							}
							setArmed(false)
							onUnfollow()
						}}
					>
						{renderIcon('close', { size: '1.05rem' })}
						{armed ? 'Confirm unfollow' : 'Unfollow'}
					</button>
				</span>
			</div>
			<details
				css={{
					...nativeDisclosureCss,
					paddingInline: '1rem',
					paddingBottom: '0.35rem',
				}}
			>
				<summary>Details</summary>
				<div>
					<MetadataGrid
						items={[
							{
								label: 'Follow ID',
								value: <IdValue value={follow.id} label="follow ID" />,
							},
							{
								label: 'Following since',
								value: <TimestampValue value={follow.createdAt} />,
							},
							{
								label: 'Event topics',
								value: follow.events.length
									? follow.events
											.map((event) => followEventCopy[event].topic)
											.join(', ')
									: 'None',
							},
							...(follow.pausedAt
								? [
										{
											label: 'Paused',
											value: <TimestampValue value={follow.pausedAt} />,
										},
									]
								: []),
							...(follow.lastDeliverySkipAt
								? [
										{
											label: 'Last skipped delivery',
											value: (
												<TimestampValue value={follow.lastDeliverySkipAt} />
											),
										},
									]
								: []),
						]}
					/>
				</div>
			</details>
		</li>
	)
}

const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.5,
}

const noteCss = {
	...mutedCopyCss,
	fontSize: typography.fontSize.sm,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const rowItemCss = {
	minWidth: 0,
	display: 'grid',
	gap: '0.25rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem 0',
}

const rowTextCss = {
	display: 'grid',
	gap: '0.2rem',
	minWidth: 0,
	flex: '1 1 16rem',
}

const rowNameLineCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
	color: colors.text,
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const rowWarningCss = {
	fontSize: typography.fontSize.sm,
	color: colors.text,
	lineHeight: 1.45,
}

const rowActionsCss = {
	display: 'flex',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
}

const chipBaseCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: '0.1rem 0.5rem',
	borderRadius: radius.full,
	fontSize: typography.fontSize.xs,
	fontWeight: 650,
	flexShrink: 0,
}

const activeChipCss = {
	...chipBaseCss,
	color: colors.primaryText,
	border: `1px solid ${colors.primary}`,
}

const pausedChipCss = {
	...chipBaseCss,
	color: colors.textMuted,
	border: `1px solid ${colors.border}`,
}

const iconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
	flexShrink: 0,
}
