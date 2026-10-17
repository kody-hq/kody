/** @jsxImportSource @emotion/react */
/** @jsxRuntime automatic */
import { type CSSProperties, type ReactNode } from 'react'
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
import { routes } from '#universal/routes.ts'
import { colors, mq, spacing } from '#universal/styles/tokens.ts'

export type PackageRepoNavActive =
	| 'repo'
	| 'files'
	| 'settings'
	| 'collaborators'
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
	/** Defaults to true. Pass false only to hide Files intentionally. */
	showFilesNav?: boolean
	active: PackageRepoNavActive
}) {
	const repoHref = routes.communityPackage.href({
		username: input.username,
		kodyId: input.kodyId,
	})
	const settingsHref = getPackageSettingsHref({
		username: input.username,
		kodyId: input.kodyId,
	})
	const showFilesNav = input.showFilesNav !== false
	return (
		<nav aria-label="Repository" data-testid="package-repo-nav" css={navCss}>
			<SiteLink
				href={repoHref}
				aria-current={input.active === 'repo' ? 'page' : undefined}
				data-testid="package-repo-nav-repo"
				css={tabCss}
			>
				Repo
			</SiteLink>
			{showFilesNav ? (
				<SiteLink
					href={input.filesHref}
					aria-current={input.active === 'files' ? 'page' : undefined}
					data-testid="package-repo-nav-files"
					css={tabCss}
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
							css={tabCss}
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
					css={tabCss}
				>
					Collaborators
				</SiteLink>
			) : null}
			{input.viewerCanManage ? (
				<SiteLink
					href={settingsHref}
					aria-current={input.active === 'settings' ? 'page' : undefined}
					data-testid="package-repo-nav-settings"
					css={tabCss}
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
	active: PackageRepoNavActive
	filesHref: string
	description?: string
	ownerProfilePublic?: boolean
	iconUrl?: string | null
	iconName?: string
	iconTestId?: string
	animate?: boolean
	/** Labeled controls on the tab row; status icons stay in the title. */
	actions?: ReactNode
}) {
	const backHref = input.viewerIsOwner
		? routes.profile.href({ username: input.username })
		: routes.community.href()
	const backLabel = input.viewerIsOwner
		? `@${input.username}`
		: 'Public packages'
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
		<div data-testid="package-repo-chrome">
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
			<div {...rise('3')} css={navRowCss}>
				{renderPackageRepoNav({
					username: input.username,
					kodyId: input.kodyId,
					filesHref: input.filesHref,
					viewerCanManage: input.viewerCanManage,
					showCredentialTabs: input.viewerIsOwner && hasPackage,
					showCollaboratorsTab:
						input.viewerCanManageAccess === true && hasPackage,
					active: input.active,
				})}
				{input.actions ? (
					<div
						role="group"
						aria-label="Repository actions"
						data-testid="package-repo-actions"
						css={actionsCss}
					>
						{input.actions}
					</div>
				) : null}
			</div>
		</div>
	)
}

const backLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}

const headCss = {
	marginTop: '1.8rem',
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
	margin: '1rem 0 0',
	color: colors.textMuted,
	fontSize: '1.05rem',
	maxWidth: '58ch',
}

const navRowCss = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	flexWrap: 'wrap' as const,
	gap: '0.75rem 1rem',
	marginTop: '1.1rem',
	[mq.mobile]: {
		flexDirection: 'column-reverse' as const,
		alignItems: 'stretch',
	},
}

const actionsCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.5rem',
}

const navCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	// Owner chrome adds Credentials / Default mappings / Triggers — keep a
	// clear gutter between labels so they do not read as one run-on string.
	gap: `0.35rem ${spacing.md}`,
}

const tabCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: '0.55rem 0.55rem',
	borderBottom: '2px solid transparent',
	color: colors.textMuted,
	fontSize: '0.95rem',
	fontWeight: 550,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
	'&[aria-current="page"]': {
		color: colors.text,
		borderBottomColor: colors.primary,
	},
}
