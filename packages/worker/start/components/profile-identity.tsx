/** @jsxImportSource @emotion/react */
import { SiteLink } from './site-link.tsx'
import { type CSSObject } from '@emotion/react'

import { workspaceLandingItem } from '#client/routes/account-rail.ts'
import { buildAuthLink } from '#client/auth-links.ts'
import { formatCommunityPublishedDate } from '#universal/community-display.ts'
import { type ProfileShellLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	pageDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import { UserAvatar } from './user-avatar.tsx'

const profilePagePath = (username: string) => routes.profile.href({ username })

export function renderProfileIdentity(
	shell: ProfileShellLoaderData,
	options?: { workspaceOrgSlug?: string | null },
) {
	const workspaceSlug = options?.workspaceOrgSlug?.trim() || shell.username
	return (
		<header css={identityCss} data-testid="profile-identity">
			<div css={avatarWrapCss}>
				<UserAvatar
					displayName={shell.displayName}
					avatarUrl={shell.avatarUrl}
					size={{ narrow: 72, wide: 160 }}
					variant="well"
					testId="profile-avatar"
				/>
			</div>
			<div css={identityCopyCss}>
				<div css={nameRowCss}>
					<h1 css={displayNameCss} data-testid="profile-display-name">
						{shell.displayName}
					</h1>
					{shell.isSelf && shell.visibility === 'private' ? (
						<span css={badgeCss} data-testid="profile-private-badge">
							Private
						</span>
					) : null}
				</div>
				<p css={usernameCss} data-testid="profile-username">
					@{shell.username}
				</p>
				{shell.bio ? (
					<p css={bioCss} data-testid="profile-bio">
						{shell.bio}
					</p>
				) : null}
				<p css={joinedCss} data-testid="profile-joined">
					Joined {formatCommunityPublishedDate(shell.joinedAt)}
				</p>
				{shell.isSelf ? (
					<div css={actionsCss} data-testid="profile-actions">
						<SiteLink
							href={workspaceLandingItem(workspaceSlug).href}
							data-testid="profile-workspace"
							css={getGhostButtonCss()}
						>
							Workspace
						</SiteLink>
						<SiteLink href={routes.account.href()} css={getGhostButtonCss()}>
							Account settings
						</SiteLink>
					</div>
				) : null}
				{!shell.loggedIn
					? renderProfileLoggedOutCtas(profilePagePath(shell.username))
					: null}
			</div>
		</header>
	)
}

export function renderOrgIdentity(input: {
	name: string
	handle: string
	avatarName: string
	role: string
}) {
	return (
		<header css={identityCss} data-testid="org-identity">
			<div css={avatarWrapCss}>
				<UserAvatar
					displayName={input.avatarName}
					avatarUrl={null}
					size={{ narrow: 72, wide: 160 }}
					variant="well"
				/>
			</div>
			<div css={identityCopyCss}>
				<div css={nameRowCss}>
					<h1 css={displayNameCss}>{input.name}</h1>
					<span css={badgeCss} data-testid="org-role">
						{input.role}
					</span>
				</div>
				<p css={usernameCss}>{input.handle}</p>
			</div>
		</header>
	)
}

function renderProfileLoggedOutCtas(returnTo: string) {
	return (
		<div css={guestCtaCss} data-testid="profile-guest-cta">
			<p css={guestCtaCopyCss}>Log in or sign up to fork these packages.</p>
			<p css={guestCtaActionsCss}>
				<SiteLink
					href={buildAuthLink(routes.login.href(), returnTo)}
					css={getGhostButtonCss()}
				>
					Log in
				</SiteLink>
				<SiteLink
					href={buildAuthLink(routes.signup.href(), returnTo)}
					css={getPillButtonCss()}
				>
					Sign up
				</SiteLink>
			</p>
		</div>
	)
}

const identityCss = {
	display: 'grid',
	gap: spacing.md,
	minWidth: 0,
} satisfies CSSObject

const avatarWrapCss = {
	lineHeight: 0,
	width: 'fit-content',
} satisfies CSSObject

const identityCopyCss = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
} satisfies CSSObject

const nameRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexWrap: 'wrap' as const,
} satisfies CSSObject

const displayNameCss = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontSize: 'clamp(1.65rem, 3vw, 2.15rem)',
	fontWeight: 740,
	letterSpacing: '-0.022em',
	lineHeight: 1.12,
	color: colors.text,
	overflowWrap: 'anywhere' as const,
} satisfies CSSObject

const usernameCss = {
	...pageDescriptionCss,
	fontSize: typography.fontSize.lg,
	color: colors.textMuted,
} satisfies CSSObject

const bioCss = {
	margin: 0,
	color: colors.text,
	maxWidth: '42ch',
	textWrap: 'pretty' as const,
	overflowWrap: 'anywhere' as const,
} satisfies CSSObject

const joinedCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
} satisfies CSSObject

const badgeCss = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
} satisfies CSSObject

const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
	marginTop: spacing.xs,
} satisfies CSSObject

const guestCtaCss = {
	display: 'grid',
	gap: spacing.sm,
	marginTop: spacing.xs,
} satisfies CSSObject

const guestCtaCopyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	maxWidth: '36ch',
} satisfies CSSObject

const guestCtaActionsCss = {
	margin: 0,
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	'& a': {
		textDecoration: 'none',
		width: 'fit-content',
	},
} satisfies CSSObject
