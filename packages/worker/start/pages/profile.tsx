/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import {
	profilePageCss,
	profileLayoutCss,
} from '../components/profile-layout.ts'
import { useShellData } from '../routes/__root.tsx'
import { usePendingProfile } from './account-profile-query.ts'
import { useRouteContext, useNavigate } from '@tanstack/react-router'
import {
	type ProfileLoaderData,
	toProfileShellLoaderData,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	defaultProfilePackageSortDirection,
	readProfilePackageFiltersFromHref,
} from '#universal/profile-search.ts'
import { ProfileContent } from '../components/profile-content.tsx'
import { renderProfileIdentity } from '../components/profile-identity.tsx'
import { ProfileRepositorySearchInput } from '../components/profile-search-field.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPrimaryButtonCss,
} from '#universal/styles/style-primitives.ts'
export function ProfileRoute({
	data: savedData,
	currentHref,
	basePath,
}: {
	data: ProfileLoaderData
	currentHref: string
	basePath?: string
}) {
	const { actorKey } = useRouteContext({ from: '__root__' })
	const pendingProfile = usePendingProfile(actorKey)
	const data =
		savedData.isSelf && pendingProfile
			? {
					...savedData,
					profile: {
						...savedData.profile,
						displayName: pendingProfile.displayName,
						bio: pendingProfile.bio,
					},
				}
			: savedData
	const { session } = useShellData()
	const readyShell = toProfileShellLoaderData(data)
	const visibleList = data
	const username = data.profile.username
	const filters = readProfilePackageFiltersFromHref(currentHref, {
		allowOwnerFilters: data.isSelf,
	})
	const searchQuery = filters.query
	const queryAppliedByLoader = new URL(
		currentHref,
		'https://kody.local',
	).searchParams.has('limit')
	const navigate = useNavigate()
	const repositoryList = (
		<>
			<form
				method="get"
				action={basePath ?? routes.profile.href({ username })}
				role="search"
				onSubmit={(event) => {
					event.preventDefault()
					const search = new URLSearchParams()
					for (const [key, value] of new FormData(event.currentTarget))
						if (typeof value === 'string') search.append(key, value)
					void navigate({
						to: `${basePath ?? routes.profile.href({ username })}?${search}`,
					})
				}}
				css={searchFormCss}
			>
				{filters.visibility !== 'all' ? (
					<input type="hidden" name="visibility" value={filters.visibility} />
				) : null}
				{filters.listing !== 'all' ? (
					<input type="hidden" name="listing" value={filters.listing} />
				) : null}
				{filters.hidden !== 'all' ? (
					<input type="hidden" name="hidden" value={filters.hidden} />
				) : null}
				{filters.app !== 'all' ? (
					<input type="hidden" name="app" value={filters.app} />
				) : null}
				{filters.package !== 'all' ? (
					<input type="hidden" name="package" value={filters.package} />
				) : null}
				{filters.sort !== 'updated' ? (
					<input type="hidden" name="sort" value={filters.sort} />
				) : null}
				{filters.dir !== defaultProfilePackageSortDirection(filters.sort) ? (
					<input type="hidden" name="dir" value={filters.dir} />
				) : null}
				<label css={searchFieldCss}>
					<span css={fieldLabelCss}>Search repositories</span>
					<ProfileRepositorySearchInput
						username={username}
						basePath={basePath}
						filters={filters}
					/>
				</label>
				<button
					type="submit"
					css={{ ...getPrimaryButtonCss(), alignSelf: 'end' }}
				>
					Search
				</button>
			</form>

			{visibleList ? (
				<ProfileContent
					basePath={basePath}
					profile={visibleList.profile}
					packages={visibleList.packages}
					activity={visibleList.activity}
					query={searchQuery || null}
					visibility={filters.visibility}
					listing={filters.listing}
					hidden={filters.hidden}
					app={filters.app}
					package={filters.package}
					sort={filters.sort}
					dir={filters.dir}
					isSelf={readyShell?.isSelf === true}
					queryAppliedByLoader={queryAppliedByLoader}
				/>
			) : null}
		</>
	)
	if (basePath)
		return (
			<div css={mainCss} data-testid="workspace-repositories">
				{repositoryList}
			</div>
		)
	return (
		<section css={profilePageCss} data-testid="profile-page">
			<div css={profileLayoutCss}>
				{readyShell
					? renderProfileIdentity(readyShell, {
							workspaceOrgSlug: session?.organizations.find(
								(org) => org.personal,
							)?.slug,
						})
					: null}

				<div css={mainCss}>
					<h2 css={packagesHeadingCss}>Repositories</h2>
					{repositoryList}
				</div>
			</div>
		</section>
	)
}

const mainCss = {
	display: 'grid',
	gap: spacing.lg,
	minWidth: 0,
} satisfies CSSObject

const packagesHeadingCss = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontSize: 'clamp(1.35rem, 2.4vw, 1.7rem)',
	fontWeight: 720,
	letterSpacing: '-0.018em',
	color: colors.text,
} satisfies CSSObject

const unavailableTitleCss = {
	margin: 0,
	fontSize: typography.fontSize['2xl'],
	fontWeight: typography.fontWeight.semibold,
} satisfies CSSObject

const searchFormCss = {
	display: 'flex',
	gap: spacing.md,
	alignItems: 'end',
	flexWrap: 'wrap' as const,
} satisfies CSSObject

const searchFieldCss = {
	...fieldCss,
	flex: '1 1 16rem',
	minWidth: '12rem',
} satisfies CSSObject

export function ProfileUnavailable() {
	return (
		<section css={profilePageCss} data-testid="profile-unavailable">
			<h1 css={unavailableTitleCss}>This profile isn't available.</h1>
		</section>
	)
}
