/** @jsxImportSource @emotion/react */
import { describeFollowEvents } from '#client/routes/follows-shared.ts'
import { docHref } from '#universal/docs-nav.ts'
import {
	followEventCopy,
	type FollowEvent,
	type FollowRecentUpdate,
} from '#universal/follows.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { formatNullableTimestamp } from './local-timestamp.tsx'
import { renderIcon } from './icon.tsx'
import { SiteLink } from './site-link.tsx'

/**
 * Shown when no enabled package subscription handles some of the selected
 * follow events, so delivery keeps them as Recent updates instead.
 */
export function FollowUnhandledNotice(props: {
	events: ReadonlyArray<FollowEvent>
	where: 'below' | 'on the Follows page'
}) {
	if (props.events.length === 0) return null
	return (
		<p data-testid="follow-unhandled-notice" css={noticeCss}>
			<span aria-hidden="true" css={noticeIconCss}>
				{renderIcon('information', { size: '1.05rem' })}
			</span>
			<span>
				No package handles {describeFollowEvents(props.events).toLowerCase()}{' '}
				yet. They appear under Recent updates {props.where}. To get them by
				email, Discord, or anything else, add a{' '}
				<SiteLink href={docHref('package-subscriptions')}>
					package subscription
				</SiteLink>{' '}
				for{' '}
				{props.events.map((event) => followEventCopy[event].topic).join(' or ')}
				.
			</span>
		</p>
	)
}

export function FollowRecentUpdatesList(props: {
	updates: ReadonlyArray<FollowRecentUpdate>
	showName: boolean
	emptyCopy: string
}) {
	if (props.updates.length === 0) {
		return (
			<p data-testid="follow-recent-updates-empty" css={mutedCss}>
				{props.emptyCopy}
			</p>
		)
	}
	return (
		<ul data-testid="follow-recent-updates" css={listCss}>
			{props.updates.map((update) => (
				<li
					key={update.id}
					data-testid="follow-recent-update"
					data-follow-event={update.event}
					css={itemCss}
				>
					<span aria-hidden="true" css={iconCss}>
						{renderIcon(update.event === 'published' ? 'box' : 'git-fork', {
							size: '1rem',
						})}
					</span>
					<span css={textCss}>
						<span css={summaryCss}>
							{props.showName ? (
								<>
									{update.href ? (
										<SiteLink href={update.href} css={nameCss}>
											{update.name}
										</SiteLink>
									) : (
										<span css={nameCss}>{update.name}</span>
									)}
									{' · '}
								</>
							) : null}
							{update.href && !props.showName ? (
								<SiteLink href={update.href}>{update.summary}</SiteLink>
							) : (
								update.summary
							)}
						</span>
						<span css={metaCss}>
							{update.event === 'published' ? 'New version' : 'Push'} ·{' '}
							<time dateTime={update.occurredAt}>
								{formatNullableTimestamp(update.occurredAt, '—')}
							</time>
						</span>
					</span>
				</li>
			))}
		</ul>
	)
}

const mutedCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.5,
	fontSize: typography.fontSize.sm,
}

const noticeCss = {
	margin: 0,
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'flex-start',
	padding: '0.65rem 0.85rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
	color: colors.text,
	lineHeight: 1.5,
	fontSize: typography.fontSize.sm,
}

const noticeIconCss = {
	display: 'inline-flex',
	paddingTop: '0.15rem',
	color: colors.textMuted,
	flexShrink: 0,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
}

const itemCss = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'flex-start',
	minWidth: 0,
}

const iconCss = {
	display: 'inline-flex',
	paddingTop: '0.2rem',
	color: colors.textMuted,
	flexShrink: 0,
}

const textCss = {
	display: 'grid',
	gap: '0.1rem',
	minWidth: 0,
}

const summaryCss = {
	color: colors.text,
	lineHeight: 1.45,
	overflowWrap: 'anywhere' as const,
}

const nameCss = {
	fontWeight: 650,
	color: colors.text,
}

const metaCss = {
	fontSize: typography.fontSize.xs,
	color: colors.textMuted,
}
