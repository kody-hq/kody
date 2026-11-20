/** @jsxImportSource @emotion/react */
/** @jsxRuntime automatic */
import type { CSSProperties, ReactNode } from 'react'
import { PackageCommands } from '../commands/package-commands.tsx'
import { packageCollaboratorsHref } from '#universal/package-collaborators.ts'
import { SiteLink } from './site-link.tsx'
import { IdentityIconMark } from './identity-icon-mark.tsx'
import { getPackageSettingsHref } from '#universal/package-files.ts'
import {
	type PackageCredentialsTab,
	packageCredentialsTabHref,
	packageCredentialsTabLabel,
	packageCredentialsTabs,
} from '#universal/package-credentials-page.ts'
import { renderPackageStatusSignifiers } from './package-status-signifiers.tsx'
import {
	underlineLinkTabCss,
	underlineLinkTabsCss,
} from '#universal/styles/style-primitives.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import { withInstallOrg } from '#universal/community-search.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'

export type PackageRepoNavActive =
	| 'repo'
	| 'files'
	| 'settings'
	| 'collaborators'
	| 'connected-people'
	/** Forks has no tab of its own; it is reached from the Forks count. */
	| 'forks'
	| PackageCredentialsTab

function renderPackageRepoNav(input: {
	username: string
	kodyId: string
	filesHref: string
	viewerCanManage: boolean
	/** Saved packages the viewer's org owns: credential and trigger tabs. */
	showCredentialTabs: boolean
	/** Saved packages the viewer may manage access to (`package:manage_access`). */
	showCollaboratorsTab: boolean
	/** Manage on a package with an app: who signed in with Kody. */
	showConnectedPeopleTab: boolean
	/** Defaults to true. Pass false only to hide Files intentionally. */
	showFilesNav?: boolean
	active: PackageRepoNavActive
	installOrg?: string | null
}) {
	const repoHref = withInstallOrg(
		routes.communityPackage.href({
			username: input.username,
			kodyId: input.kodyId,
		}),
		input.installOrg,
	)
	const settingsHref = getPackageSettingsHref({
		username: input.username,
		kodyId: input.kodyId,
	})
	const showFilesNav = input.showFilesNav !== false
	return (
		<nav
			aria-label="Repository"
			data-testid="package-repo-nav"
			ref={revealCurrentTab}
			css={underlineLinkTabsCss}
		>
			<SiteLink
				href={repoHref}
				aria-current={input.active === 'repo' ? 'page' : undefined}
				data-testid="package-repo-nav-repo"
				css={underlineLinkTabCss}
			>
				Repo
			</SiteLink>
			{showFilesNav ? (
				<SiteLink
					href={withInstallOrg(input.filesHref, input.installOrg)}
					aria-current={input.active === 'files' ? 'page' : undefined}
					data-testid="package-repo-nav-files"
					css={underlineLinkTabCss}
				>
					Files
				</SiteLink>
			) : null}
			{input.showCredentialTabs
				? packageCredentialsTabs.map((tab) => (
						<SiteLink
							key={tab}
							href={packageCredentialsTabHref({
								username: input.username,
								kodyId: input.kodyId,
								tab,
							})}
							aria-current={input.active === tab ? 'page' : undefined}
							data-testid={`package-repo-nav-${tab}`}
							css={underlineLinkTabCss}
						>
							{packageCredentialsTabLabel(tab)}
						</SiteLink>
					))
				: null}
			{input.showCollaboratorsTab ? (
				<SiteLink
					href={packageCollaboratorsHref({
						username: input.username,
						kodyId: input.kodyId,
					})}
					aria-current={input.active === 'collaborators' ? 'page' : undefined}
					data-testid="package-repo-nav-collaborators"
					css={underlineLinkTabCss}
				>
					Collaborators
				</SiteLink>
			) : null}
			{input.showConnectedPeopleTab ? (
				<SiteLink
					href={routes.communityPackageConnectedPeople.href({
						username: input.username,
						kodyId: input.kodyId,
					})}
					aria-current={
						input.active === 'connected-people' ? 'page' : undefined
					}
					data-testid="package-repo-nav-connected-people"
					css={underlineLinkTabCss}
				>
					Connected people
				</SiteLink>
			) : null}
			{input.viewerCanManage ? (
				<SiteLink
					href={settingsHref}
					aria-current={input.active === 'settings' ? 'page' : undefined}
					data-testid="package-repo-nav-settings"
					css={underlineLinkTabCss}
				>
					Settings
				</SiteLink>
			) : null}
		</nav>
	)
}

export function renderPackageRepoChrome(input: {
	username: string
	kodyId: string
	isPrivate: boolean
	isListed?: boolean
	/** Defaults to true (saved package). Plain repos pass false. */
	hasPackage?: boolean
	viewerIsOwner: boolean
	viewerCanManage: boolean
	/** Shows the Collaborators tab. Defaults to false. */
	viewerCanManageAccess?: boolean
	/** Shows the Connected people tab. Defaults to false. */
	viewerCanSeeConnectedPeople?: boolean
	active: PackageRepoNavActive
	filesHref: string
	description?: string
	ownerProfilePublic?: boolean
	iconUrl?: string | null
	iconName?: string
	iconTestId?: string
	animate?: boolean
	/** Labeled controls beside the title; status icons stay in the title. */
	actions?: ReactNode
	/** Picked install org (`?org=`), kept on tab and catalog links. */
	installOrg?: string | null
}) {
	const backHref = input.viewerIsOwner
		? orgResourcePath(input.username, 'repositories')
		: withInstallOrg(routes.community.href(), input.installOrg)
	const backLabel = input.viewerIsOwner ? 'Repositories' : 'Public packages'
	const profileHref =
		input.ownerProfilePublic === false
			? null
			: routes.profile.href({ username: input.username })
	const rise = (step: string) =>
		input.animate
			? ({
					'data-rise': true,
					style: { '--rise': step } as CSSProperties & { '--rise': string },
				} as const)
			: {}
	const isListed = input.isListed === true
	const hasPackage = input.hasPackage !== false

	return (
		<div data-testid="package-repo-chrome" css={chromeCss}>
			<PackageCommands {...input} />
			<SiteLink
				{...rise('0')}
				href={backHref}
				data-testid="package-repo-back"
				css={backLinkCss}
			>
				← {backLabel}
			</SiteLink>
			<header {...rise('1')} css={headCss}>
				<IdentityIconMark
					name={input.iconName ?? input.kodyId}
					iconUrl={input.iconUrl ?? null}
					size="detail"
					testId={
						input.iconTestId ??
						(isListed
							? 'community-listing-icon-detail'
							: 'package-identity-icon-detail')
					}
				/>
				<h1 css={titleCss}>
					{profileHref ? (
						<SiteLink href={profileHref} css={ownerLinkCss}>
							@{input.username}
						</SiteLink>
					) : (
						<span data-testid="community-detail-owner-private">
							@{input.username}
						</span>
					)}
					<span css={slashCss}>/</span>
					<span data-testid="package-title-name" css={titleNameCss}>
						<span css={titleLeafCss}>{input.kodyId}</span>
						{renderPackageStatusSignifiers({
							isPrivate: input.isPrivate,
							isListed,
							hasPackage,
						})}
					</span>
				</h1>
			</header>
			{input.description ? (
				<p {...rise('2')} css={descriptionCss}>
					{input.description}
				</p>
			) : null}
			{input.actions ? (
				<div
					{...rise('2')}
					role="group"
					aria-label="Repository actions"
					data-testid="package-repo-actions"
					css={actionsCss}
				>
					{input.actions}
				</div>
			) : null}
			<div {...rise('3')} css={navRowCss}>
				{renderPackageRepoNav({
					username: input.username,
					kodyId: input.kodyId,
					filesHref: input.filesHref,
					installOrg: input.installOrg,
					viewerCanManage: input.viewerCanManage,
					showCredentialTabs: input.viewerIsOwner && hasPackage,
					showCollaboratorsTab:
						input.viewerCanManageAccess === true && hasPackage,
					showConnectedPeopleTab:
						input.viewerCanSeeConnectedPeople === true && hasPackage,
					active: input.active,
				})}
			</div>
		</div>
	)
}

/**
 * Keeps the current tab in view when the tab row scrolls sideways on narrow
 * screens. Only the row scrolls; the page never jumps.
 */
function revealCurrentTab(nav: HTMLElement | null) {
	const current = nav?.querySelector<HTMLElement>('[aria-current="page"]')
	if (!nav || !current) return
	const overflow = current.offsetLeft + current.offsetWidth - nav.clientWidth
	if (overflow > 0) nav.scrollLeft = overflow + current.offsetWidth / 2
}

const backLinkCss = {
	gridArea: 'back',
	justifySelf: 'start',
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}

/**
 * Title with labeled actions at its end on wide screens. On narrow screens
 * the actions drop under the description so the title and its description
 * stay together.
 */
const chromeCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	gridTemplateAreas:
		'"back back" "head actions" "description description" "nav nav"',
	columnGap: spacing.lg,
	alignItems: 'center',
	[mq.tablet]: {
		gridTemplateColumns: 'minmax(0, 1fr)',
		gridTemplateAreas: '"back" "head" "description" "actions" "nav"',
	},
}

const headCss = {
	gridArea: 'head',
	marginTop: spacing.lg,
	display: 'flex',
	alignItems: 'center',
	gap: '0.85rem',
	minWidth: 0,
}

const titleCss = {
	margin: 0,
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.45rem',
	fontSize: 'clamp(1.5rem, 3.6vw, 2rem)',
	fontWeight: 760,
	letterSpacing: '-0.024em',
	lineHeight: 1.15,
	overflowWrap: 'anywhere' as const,
	minWidth: 0,
}

// Keep the leaf name with its status icons. A wrap between them parks the
// verify/fork control on the package mark, where it reads as a badge.
const titleNameCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.75rem',
	flexWrap: 'nowrap' as const,
	minWidth: 0,
	maxWidth: '100%',
}

const titleLeafCss = {
	minWidth: 0,
	overflowWrap: 'anywhere' as const,
}

const slashCss = {
	color: colors.textMuted,
	fontWeight: 500,
}

const ownerLinkCss = {
	color: colors.text,
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		color: colors.primaryText,
	},
}

const descriptionCss = {
	gridArea: 'description',
	margin: `${spacing.sm} 0 0`,
	color: colors.textMuted,
	fontSize: typography.fontSize.base,
	maxWidth: '62ch',
}

/**
 * Body under the package tab row. Owns the gap below the tabs and the stack
 * gap between blocks, so tab pages render bare cards and sections.
 */
export function PackageRepoTabPanel(props: { children: ReactNode }) {
	return (
		<div data-package-tab-panel css={packageRepoTabPanelCss}>
			{props.children}
		</div>
	)
}

const packageRepoTabPanelCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr)',
	alignContent: 'start',
	gap: spacing.lg,
	marginTop: spacing.xl,
	minWidth: 0,
	'& > *': { marginBlock: 0 },
	[mq.mobile]: {
		gap: spacing.md,
		marginTop: spacing.lg,
	},
}

const navRowCss = {
	gridArea: 'nav',
	marginTop: spacing.lg,
	minWidth: 0,
}

const actionsCss = {
	gridArea: 'actions',
	marginTop: spacing.lg,
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
}
