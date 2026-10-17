/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import {
	profilePageCss,
	profileLayoutCss,
} from '../components/profile-layout.ts'
import { renderOrgIdentity } from '../components/profile-identity.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'
import {
	teamOrgManagementItems,
	workspaceLandingItem,
} from '#client/routes/account-rail.ts'
import { type IconName, renderIcon } from '../components/icon.tsx'
import {
	orgBillingPath,
	orgIdentity,
	orgRoleLabel,
	orgMembersPath,
	orgResourcePath,
	orgRoleManagesBilling,
	orgSettingsPath,
} from '#universal/org-pages.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
/**
 * Main column of a non-personal organization's home. Repositories,
 * connections, secrets, jobs, and the other org sections read that org.
 * Grant-only collaborators see what was shared with them instead of member
 * management.
 */
function renderOrgHomeMain(input: {
	slug: string
	handle: string
	role: OrgRole | null
}) {
	const collaborator = input.role === null
	const manageItems = teamOrgManagementItems({
		orgSlug: input.slug,
		role: input.role,
	})
	const homeItems =
		manageItems.length > 0
			? [workspaceLandingItem(input.slug), ...manageItems]
			: []
	return (
		<div css={mainCss} data-testid="org-home">
			{homeItems.length > 0 ? (
				<nav
					aria-label={`${input.handle} sections`}
					data-testid="org-home-nav"
					css={navCss}
				>
					<p css={navEyebrowCss}>Organization</p>
					<ul css={navListCss}>
						{homeItems.map((item) => (
							<li key={item.href}>
								<SiteLink
									href={item.href}
									data-testid={`org-home-nav-${item.label.toLowerCase()}`}
									css={navLinkCss}
								>
									<span aria-hidden="true" css={navIconCss}>
										{renderIcon(item.icon, { size: '1.1rem' })}
									</span>
									{item.label}
								</SiteLink>
							</li>
						))}
					</ul>
				</nav>
			) : null}
			<h2 css={headingCss}>Get started</h2>
			<ul css={stepListCss}>
				{collaborator
					? renderStep({
							icon: 'key',
							title: 'Use what was shared with you',
							body: `${input.handle} shared specific resources with you. To use them, connect an agent and choose ${input.handle} on the approval screen.`,
							action: (
								<SiteLink
									href={orgResourcePath(input.slug, 'agents')}
									css={getGhostButtonCss({ size: 'sm' })}
								>
									Connect an agent
								</SiteLink>
							),
						})
					: input.role === 'owner'
						? renderStep({
								icon: 'users',
								title: 'Invite members and share access',
								body: `Add people to ${input.handle} and choose their role. You can also update the organization's profile.`,
								action: (
									<div css={stepActionsCss}>
										<SiteLink
											href={orgMembersPath(input.slug)}
											css={getGhostButtonCss({ size: 'sm' })}
										>
											Members
										</SiteLink>
										<SiteLink
											href={orgSettingsPath(input.slug)}
											css={getGhostButtonCss({ size: 'sm' })}
										>
											Settings
										</SiteLink>
									</div>
								),
							})
						: renderStep({
								icon: 'users',
								title: 'View members and the organization profile',
								body: `See who is in ${input.handle} and open the organization's profile. Only an Owner can invite people or edit settings.`,
								action: (
									<div css={stepActionsCss}>
										<SiteLink
											href={orgMembersPath(input.slug)}
											css={getGhostButtonCss({ size: 'sm' })}
										>
											Members
										</SiteLink>
										<SiteLink
											href={orgSettingsPath(input.slug)}
											css={getGhostButtonCss({ size: 'sm' })}
										>
											Settings
										</SiteLink>
									</div>
								),
							})}
				{orgRoleManagesBilling(input.role)
					? renderStep({
							icon: 'wallet',
							title: 'Billing and seats',
							body: `Subscribe ${input.handle} to Kody Pro, billed per seat: every owner and member is one. Invoices and the payment method live there too.`,
							action: (
								<SiteLink
									href={orgBillingPath(input.slug)}
									data-testid="org-home-billing"
									css={getGhostButtonCss({ size: 'sm' })}
								>
									Open billing
								</SiteLink>
							),
						})
					: null}
				{/* Grant-only collaborators open Agents only (orgSectionDenial);
            members get the full workspace. The collaborator CTA above already
            covers Agents, so skip this step for them. */}
				{collaborator
					? null
					: renderStep({
							icon: 'box',
							title: 'Repositories, agents, credentials, and jobs',
							body: `${input.handle} has its own repositories, connected agents, credentials, and jobs, separate from your personal account.`,
							action: (
								<div css={stepActionsCss}>
									<SiteLink
										href={orgResourcePath(input.slug, 'repositories')}
										css={getGhostButtonCss({ size: 'sm' })}
									>
										Repositories
									</SiteLink>
									<SiteLink
										href={orgResourcePath(input.slug, 'jobs')}
										css={getGhostButtonCss({ size: 'sm' })}
									>
										Jobs
									</SiteLink>
									<SiteLink
										href={orgResourcePath(input.slug, 'agents')}
										css={getGhostButtonCss({ size: 'sm' })}
									>
										Agents
									</SiteLink>
									<SiteLink
										href={orgResourcePath(input.slug, 'credentials')}
										css={getGhostButtonCss({ size: 'sm' })}
									>
										Credentials
									</SiteLink>
								</div>
							),
						})}
			</ul>
		</div>
	)
}
function renderStep(input: {
	icon: IconName
	title: string
	body: string
	action: ReactNode | null
}) {
	return (
		<li css={stepCss}>
			<span aria-hidden="true" css={stepIconCss}>
				{renderIcon(input.icon, { size: '1.25rem' })}
			</span>
			<div css={stepCopyCss}>
				<h3 css={stepTitleCss}>{input.title}</h3>
				<p css={stepBodyCss}>{input.body}</p>
				{input.action ? <div>{input.action}</div> : null}
			</div>
		</li>
	)
}
const mainCss = {
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
}
const navCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.lg,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}
const navEyebrowCss = {
	margin: 0,
	fontSize: '0.72rem',
	fontWeight: 650,
	letterSpacing: '0.08em',
	textTransform: 'uppercase' as const,
	color: colors.textMuted,
}
const navListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}
const navLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	padding: `${spacing.sm} ${spacing.md}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	color: colors.text,
	textDecoration: 'none',
	fontSize: '0.95rem',
	fontWeight: 600,
	'&:hover': {
		borderColor: colors.primary,
		color: colors.primaryText,
	},
}
const navIconCss = {
	display: 'inline-flex',
	color: colors.primaryText,
}
const headingCss = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontSize: 'clamp(1.35rem, 2.4vw, 1.7rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	color: colors.text,
}
const stepListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.md,
}
const stepCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	padding: spacing.lg,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}
const stepIconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	flexShrink: 0,
	width: '2.5rem',
	height: '2.5rem',
	borderRadius: radius.full,
	backgroundColor: colors.primarySoftest,
	color: colors.primaryText,
}
const stepCopyCss = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
}
const stepActionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}
const stepTitleCss = {
	margin: 0,
	fontSize: '1.05rem',
	fontWeight: 650,
	color: colors.text,
}
const stepBodyCss = {
	margin: 0,
	color: colors.textMuted,
	maxWidth: '60ch',
}

export function OrgHomePage({
	org,
}: {
	org: {
		slug: string
		displayName: string | null
		avatarUrl?: string | null
		role: OrgRole | null
	}
}) {
	const identity = orgIdentity(
		{ ...org, personal: false },
		{
			displayName: '',
			avatarUrl: null,
		},
	)
	return (
		<section css={profilePageCss} data-testid="org-page">
			<div css={profileLayoutCss}>
				{renderOrgIdentity({
					name: identity.name,
					handle: identity.handle,
					avatarName: identity.avatarName,
					role: orgRoleLabel(org.role),
				})}
				{renderOrgHomeMain({
					slug: org.slug,
					handle: identity.handle,
					role: org.role,
				})}
			</div>
		</section>
	)
}
