/** @jsxImportSource @emotion/react */
import { SiteLink } from './site-link.tsx'
/** @jsxRuntime automatic */
import { type CSSObject } from '@emotion/react'

import {
	communityPackageCategoryCopy,
	type CommunityListingCategory,
} from '#universal/community-categories.ts'
import { routes } from '#universal/routes.ts'
import { docHref } from '#universal/docs-nav.ts'
import {
	buildCommunityIndexHref,
	type CommunityListingSort,
} from '#universal/community-search.ts'
import { colors } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

function buildCreatePackagePrompt(query: string) {
	return `I searched Kody Community for "${query}" and found no published package. Create this package for me. First open search({ entity: ["guide:package_authoring", "guide:package_lifecycle"] }). Then choose a scoped package.json name (@you/leaf) and call packageGetGitRemote({ create: true, kody_id: '@you/leaf' }) to create its repository. Build, test, and publish a useful package that matches my search.`
}

/**
 * Catalog and search-miss empty state for the community listings frame.
 * Rendered only when the resolved listings query is actually empty — not as
 * a loading placeholder, so first paint never flashes "no results."
 */
export function renderCommunityEmptyState(
	query: string | null,
	sort?: CommunityListingSort,
	category?: CommunityListingCategory | null,
) {
	if (query) {
		const createPackagePrompt = buildCreatePackagePrompt(query)
		return (
			<div css={emptyCss} data-testid="community-listings-empty">
				<h2 css={emptyTitleCss}>Nothing matched that search.</h2>
				<p css={emptyTextCss}>
					No published public package matches <strong>{query}</strong> yet. You
					can ask your agent to create it.
				</p>
				<details css={createPackageCss}>
					<summary css={getPillButtonCss()}>
						Ask your agent to create this package
					</summary>
					<div css={promptPanelCss}>
						<p css={promptIntroCss}>
							Copy this prompt into your MCP-capable agent:
						</p>
						<pre css={promptCss} data-testid="community-create-prompt">
							<code>{createPackagePrompt}</code>
						</pre>
					</div>
				</details>
				<p css={secondaryCtaCss}>
					<SiteLink
						href={docHref('package-authoring')}
						css={getGhostButtonCss()}
					>
						Read the package authoring guide
					</SiteLink>
					<SiteLink
						href={buildCommunityIndexHref({ sort, category })}
						css={secondaryLinkCss}
					>
						Clear search
					</SiteLink>
				</p>
			</div>
		)
	}

	if (category) {
		const copy = communityPackageCategoryCopy[category]
		return (
			<div css={emptyCss} data-testid="community-listings-empty">
				<h2 css={emptyTitleCss}>
					Nothing in <em>{copy.label}</em> yet.
				</h2>
				<p css={emptyTextCss}>{copy.description}</p>
				<p css={emptyCtaCss}>
					<SiteLink
						href={buildCommunityIndexHref({ sort })}
						css={getGhostButtonCss()}
					>
						Browse all packages
					</SiteLink>
				</p>
			</div>
		)
	}

	return (
		<div css={emptyCss} data-testid="community-listings-empty">
			<h2 css={emptyTitleCss}>
				The shelf is <em>waiting</em>.
			</h2>
			<p css={emptyTextCss}>
				Nobody has published a public package yet. Ask your agent to share
				something useful — forks keep their own history.
			</p>
			<p css={emptyCtaCss}>
				<SiteLink href={routes.onboarding.href()} css={getPillButtonCss()}>
					Connect your agent
				</SiteLink>
			</p>
		</div>
	)
}

const emptyCss = {
	margin: '1.2rem 0 0',
	maxWidth: '40rem',
} satisfies CSSObject

const emptyTitleCss = {
	margin: 0,
	fontSize: 'clamp(1.5rem, 2.8vw, 2rem)',
	fontWeight: 740,
	letterSpacing: '-0.022em',
	lineHeight: 1.12,
	'& em': {
		fontStyle: 'normal',
		color: colors.primaryText,
	},
} satisfies CSSObject

const emptyTextCss = {
	margin: '0.9rem 0 0',
	color: colors.textMuted,
	maxWidth: '46ch',
	textWrap: 'pretty' as const,
} satisfies CSSObject

const emptyCtaCss = {
	margin: '1.5rem 0 0',
} satisfies CSSObject

const createPackageCss = {
	marginTop: '1.5rem',
	'&[open] > summary': {
		marginBottom: '0.9rem',
	},
	'& > summary': {
		cursor: 'pointer',
		listStyle: 'none',
		width: 'fit-content',
	},
	'& > summary::-webkit-details-marker': {
		display: 'none',
	},
} satisfies CSSObject

const promptPanelCss = {
	padding: '1rem',
	backgroundColor: colors.surface,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.8rem',
} satisfies CSSObject

const promptIntroCss = {
	margin: '0 0 0.65rem',
	color: colors.textMuted,
	fontSize: '0.9rem',
} satisfies CSSObject

const promptCss = {
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
	fontFamily: 'inherit',
	fontSize: '0.95rem',
	lineHeight: 1.55,
	userSelect: 'text' as const,
} satisfies CSSObject

const secondaryCtaCss = {
	margin: '1rem 0 0',
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: '0.9rem',
} satisfies CSSObject

const secondaryLinkCss = {
	color: colors.primaryText,
	fontWeight: 650,
	textUnderlineOffset: '0.18em',
} satisfies CSSObject
