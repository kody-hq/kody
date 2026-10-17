/** @jsxImportSource @emotion/react */
import { useInviteHandoff } from '../use-invite-handoff.ts'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import {
	createTeamInviteLink,
	revokeTeamInviteLink,
} from '#start/server/invite-links'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { teamInviteMutationOptions } from './org-team-invite-mutation.ts'

import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { renderIcon } from '../components/icon.tsx'
import {
	type OrgTeamView,
	type ScopedInviteLinkView,
} from '#universal/loader-data.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

async function copyText(text: string) {
	try {
		await navigator.clipboard.writeText(text)
		return true
	} catch {
		return false
	}
}

function creatorLabel(link: ScopedInviteLinkView) {
	if (link.createdByDisplayName?.trim()) return link.createdByDisplayName.trim()
	if (link.createdByUsername) return `@${link.createdByUsername}`
	return 'Someone'
}

/**
 * Per-team invite links on the Teams page. Accepting one adds the person to
 * the org as Member (when they are not one yet) and to the team.
 */
export function OrgTeamInviteLinks({
	team,
	links,
	orgSlug,
	queryKey,
	onMessage,
}: {
	team: OrgTeamView
	links: ReadonlyArray<ScopedInviteLinkView>
	orgSlug: string
	queryKey: QueryKey
	onMessage: (message: string, tone: 'info' | 'error') => void
}) {
	const client = useQueryClient()
	const capture = useSubmitterScope()
	const [created, setCreated] = useInviteHandoff<{ id: string; url: string }>(
		links,
	)
	const create = useMutation(
		teamInviteMutationOptions(
			client,
			queryKey,
			async (input: {
				orgSlug: string
				teamId: string
				active: () => boolean
			}) => {
				const result = await createTeamInviteLink({
					data: { orgSlug: input.orgSlug, teamId: input.teamId },
				})
				if (!input.active()) return
				// The one-time URL belongs only to this mounted form, never the query or mutation cache.
				setCreated(result.inviteLink)
				const copied = await copyText(result.inviteLink.url)
				if (input.active())
					onMessage(
						copied
							? 'Team invite link copied to clipboard.'
							: 'Team invite link created. Copy it below; it is shown only once.',
						'info',
					)
			},
		),
	)
	const revoke = useMutation(
		teamInviteMutationOptions(
			client,
			queryKey,
			async (input: { orgSlug: string; linkId: string }) => {
				await revokeTeamInviteLink({ data: input })
			},
		),
	)
	const busy = create.isPending
		? `create:${team.id}`
		: revoke.isPending
			? `revoke:${revoke.variables?.linkId}`
			: null
	async function createLink() {
		if (busy) return
		const active = capture()
		onMessage('', 'info')
		try {
			await create.mutateAsync({ orgSlug, teamId: team.id, active })
		} catch (error) {
			if (active())
				onMessage(
					error instanceof Error
						? error.message
						: 'Unable to create team invite link.',
					'error',
				)
		}
	}
	async function revokeLink(linkId: string) {
		if (busy) return
		const active = capture()
		onMessage('', 'info')
		try {
			await revoke.mutateAsync({ orgSlug, linkId })
			if (!active()) return
			if (created?.id === linkId) setCreated(null)
			onMessage('Team invite link revoked.', 'info')
		} catch (error) {
			if (active())
				onMessage(
					error instanceof Error
						? error.message
						: 'Unable to revoke team invite link.',
					'error',
				)
		}
	}
	const teamLinks = links.filter((link) => link.teamId === team.id)
	const createdUrl = created?.url
	return (
		<div css={sectionCss} data-testid="org-team-invite-links">
			<div css={headerCss}>
				<span css={detailCss}>
					Invite link: whoever accepts joins this team, and the organization as
					Member if they are not in it yet.
				</span>
				<button
					type="button"
					disabled={busy !== null}
					data-testid="org-team-invite-link-create"
					css={getPillButtonCss({ size: 'sm' })}
					onClick={() => void createLink()}
				>
					{renderIcon('link', { size: '1.05rem' })}
					{busy === `create:${team.id}` ? 'Creating…' : 'Copy invite link'}
				</button>
			</div>
			{createdUrl ? (
				<div css={createdCss} data-testid="org-team-invite-link-url">
					<code css={codeCss}>{createdUrl}</code>
				</div>
			) : null}
			{teamLinks.length > 0 ? (
				<ul css={listCss}>
					{teamLinks.map((link) => (
						<li key={link.id} css={rowCss} data-testid="org-team-invite-link">
							<span css={detailCss}>
								{[
									`${link.useCount}${link.maxUses != null ? ` / ${link.maxUses}` : ''} uses`,
									`Expires ${formatTimestampDate(link.expiresAt)}`,
									`Created by ${creatorLabel(link)}`,
								].join(' · ')}
							</span>
							<button
								type="button"
								disabled={busy !== null}
								css={getDangerPillCss({ size: 'sm' })}
								onClick={() => void revokeLink(link.id)}
							>
								{busy === `revoke:${link.id}` ? 'Revoking…' : 'Revoke'}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	)
}

const sectionCss = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.sm,
	paddingTop: spacing.sm,
	borderTop: `1px solid ${colors.border}`,
}

const headerCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
}

const detailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
	minWidth: 0,
}

const createdCss = {
	padding: spacing.sm,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const codeCss = {
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
	color: colors.text,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
}

const rowCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
}
