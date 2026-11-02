/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useEffect } from 'react'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgApps } from '#start/server/org-management'
import {
	AccountManagementShell,
	AccountPageHeader,
} from '../pages/account-management-components.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { routes } from '#universal/routes.ts'
import { colors } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	inputCss,
} from '#universal/styles/style-primitives.ts'
import { IdentityIconMark } from '../components/identity-icon-mark.tsx'
import { renderIcon } from '../components/icon.tsx'
import { filterWorkspaceApps } from '#universal/workspace-apps.ts'

const pageQuery = createPageQuery('loadOrgApps', loadOrgApps, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/apps')({
	staticData: {
		presentationSearchKeys: ['q', 'visibility', 'sort', 'view'],
		workspaceSwitch: { section: 'apps' },
		navigation: { rail: 'workspace', item: 'apps' },
		orgScope: { section: 'apps' },
		shell: { gutters: 'page' },
	},
	validateSearch: (search: Record<string, unknown>) => ({
		q: typeof search.q === 'string' ? search.q : '',
		visibility:
			search.visibility === 'private' || search.visibility === 'public'
				? search.visibility
				: 'all',
		sort:
			search.sort === 'name' || search.sort === 'created'
				? search.sort
				: 'updated',
		view:
			search.view === 'icons' ||
			search.view === 'list' ||
			search.view === 'cards'
				? search.view
				: undefined,
	}),
	search: {
		middlewares: [
			stripSearchParams({
				q: '',
				visibility: 'all',
				sort: 'updated',
			}),
		],
	},
	beforeLoad: ({ params }) => ({ pageQueryInput: { slug: params.orgSlug } }),
	shouldReload: ({ context }) => !context.inPlaceNavigation,
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: () => ({ meta: [{ title: 'Apps' }] }),
	component: Page,
})

function Page() {
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	const { data } = usePageQuery(pageQuery(actorKey, pageQueryInput))
	const { q, visibility, sort, view: urlView } = Route.useSearch()
	const navigate = Route.useNavigate()
	const view = urlView ?? 'cards'
	useEffect(() => {
		if (urlView) return
		let preferred: 'icons' | 'cards' | 'list' = 'cards'
		try {
			const saved = localStorage.getItem('kody.apps.view')
			if (saved === 'icons' || saved === 'list' || saved === 'cards')
				preferred = saved
		} catch {
			// Storage can be unavailable in private browsing or restricted contexts.
		}
		void navigate({
			search: (previous) => ({ ...previous, view: preferred }),
			replace: true,
			resetScroll: false,
		})
	}, [navigate, urlView])
	const apps = filterWorkspaceApps(data.apps, { query: q, visibility, sort })
	return (
		<AccountManagementShell layout="list" currentHref={pageLocation.href}>
			<AccountPageHeader title="Apps" currentHref={pageLocation.href} />
			{data.apps.length > 0 && (
				<div css={toolbarCss}>
					<label css={searchLabelCss}>
						<span>Search apps</span>
						<input
							css={inputCss}
							type="search"
							value={q}
							onChange={(event) => {
								const q = event.target.value
								void navigate({
									search: (previous) => ({ ...previous, q }),
									replace: true,
									resetScroll: false,
								})
							}}
							placeholder="Search apps"
						/>
					</label>
					<label css={controlLabelCss}>
						Package visibility
						<select
							css={inputCss}
							value={visibility}
							onChange={(event) => {
								const visibility = event.target.value as
									| 'all'
									| 'public'
									| 'private'
								void navigate({
									search: (previous) => ({ ...previous, visibility }),
									resetScroll: false,
								})
							}}
						>
							<option value="all">All packages</option>
							<option value="public">Public packages</option>
							<option value="private">Private packages</option>
						</select>
					</label>
					<label css={controlLabelCss}>
						Sort by
						<select
							css={inputCss}
							value={sort}
							onChange={(event) => {
								const sort = event.target.value as
									| 'name'
									| 'created'
									| 'updated'
								void navigate({
									search: (previous) => ({ ...previous, sort }),
									resetScroll: false,
								})
							}}
						>
							<option value="updated">Recently updated</option>
							<option value="created">Recently created</option>
							<option value="name">Name</option>
						</select>
					</label>
					<fieldset css={viewCss}>
						<legend>View</legend>
						{(
							[
								{ mode: 'icons', label: 'Icon view', icon: 'apps' },
								{ mode: 'cards', label: 'Card view', icon: 'view-cards' },
								{ mode: 'list', label: 'List view', icon: 'view-list' },
							] as const
						).map(({ mode, label, icon }) => (
							<button
								key={mode}
								type="button"
								aria-label={label}
								title={label}
								aria-pressed={view === mode}
								css={viewButtonCss(view === mode)}
								onClick={() => {
									try {
										localStorage.setItem('kody.apps.view', mode)
									} catch {
										/* The view still works without storage. */
									}
									void navigate({
										search: (previous) => ({ ...previous, view: mode }),
										resetScroll: false,
									})
								}}
							>
								{renderIcon(icon, { size: '1rem' })}
							</button>
						))}
					</fieldset>
				</div>
			)}
			{data.apps.length === 0 ? (
				<p>
					No apps in this workspace yet. Apps are hosted by packages in your
					repositories.
				</p>
			) : apps.length === 0 ? (
				<p>No apps match your search or filters.</p>
			) : (
				<ul
					css={
						view === 'list' ? listCss : view === 'icons' ? iconGridCss : gridCss
					}
					data-testid="workspace-apps"
				>
					{apps.map((app) =>
						view === 'icons' ? (
							<li key={app.kodyId} css={iconTileCss}>
								{app.appHref ? (
									<a href={app.appHref} css={iconTileLinkCss}>
										<IdentityIconMark
											name={app.name}
											iconUrl={app.iconUrl}
											size="app"
										/>
										<span>{app.name}</span>
									</a>
								) : app.canOpenDetail !== false ? (
									<SiteLink
										href={routes.communityPackage.href({
											username: data.username,
											kodyId: app.kodyId,
										})}
										css={iconTileLinkCss}
									>
										<IdentityIconMark
											name={app.name}
											iconUrl={app.iconUrl}
											size="app"
										/>
										<span>{app.name}</span>
									</SiteLink>
								) : (
									<div css={iconTileLinkCss}>
										<IdentityIconMark
											name={app.name}
											iconUrl={app.iconUrl}
											size="app"
										/>
										<span>{app.name}</span>
									</div>
								)}
							</li>
						) : (
							<li
								key={app.kodyId}
								css={[cardCss, view === 'list' && listCardCss]}
							>
								<div css={[artCss, view !== 'cards' && compactArtCss]}>
									<IdentityIconMark
										name={app.name}
										iconUrl={app.iconUrl}
										size="detail"
									/>
								</div>
								<div css={[bodyCss, view === 'list' && listBodyCss]}>
									<h2 css={titleCss}>{app.name}</h2>
									{app.description && (
										<p css={descriptionCss}>{app.description}</p>
									)}
									<div css={linksCss}>
										{app.appHref && (
											<a
												href={app.appHref}
												css={getPillButtonCss({ size: 'sm' })}
											>
												Open app
											</a>
										)}
										{app.canOpenDetail !== false && (
											<SiteLink
												css={getGhostButtonCss({ size: 'sm' })}
												href={routes.communityPackage.href({
													username: data.username,
													kodyId: app.kodyId,
												})}
											>
												Package
											</SiteLink>
										)}
									</div>
								</div>
							</li>
						),
					)}
				</ul>
			)}
		</AccountManagementShell>
	)
}
const gridCss = css({
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))',
	gap: 20,
	listStyle: 'none',
	padding: 0,
	margin: 0,
})
const cardCss = css({
	border: `1px solid ${colors.border}`,
	borderRadius: 12,
	overflow: 'hidden',
	display: 'flex',
	flexDirection: 'column',
})
const artCss = css({
	aspectRatio: '16 / 9',
	display: 'grid',
	placeItems: 'center',
	background: colors.primarySoftest,
})
const bodyCss = css({
	padding: 20,
	display: 'flex',
	flexDirection: 'column',
	flex: 1,
	gap: 12,
})
const titleCss = css({ margin: 0, fontSize: 20 })
const descriptionCss = css({ margin: 0, lineHeight: 1.5 })
const linksCss = css({
	display: 'flex',
	gap: 20,
	marginTop: 'auto',
	paddingTop: 8,
})

const toolbarCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'end',
	gap: 12,
	marginBottom: 24,
})
const controlLabelCss = css({
	display: 'grid',
	gap: 6,
	fontSize: 13,
	fontWeight: 600,
})
const searchLabelCss = css(controlLabelCss, { flex: '1 1 220px' })
const viewCss = css({
	display: 'flex',
	gap: 0,
	border: 0,
	margin: 0,
	padding: 0,
	legend: { fontSize: 13, fontWeight: 600, padding: 0, marginBottom: 6 },
})
const viewButtonCss = (active: boolean) =>
	css({
		border: `1px solid ${colors.border}`,
		borderRadius: 0,
		width: 38,
		height: 38,
		display: 'grid',
		placeItems: 'center',
		'&:first-of-type': { borderRadius: '6px 0 0 6px' },
		'&:last-of-type': { borderRadius: '0 6px 6px 0' },
		'& + &': { marginLeft: -1 },
		background: active ? colors.primarySoft : colors.surface,
		color: colors.text,
		cursor: 'pointer',
		fontWeight: active ? 700 : 400,
	})
const listCss = css(gridCss, { gridTemplateColumns: '1fr', gap: 10 })
const iconGridCss = css(gridCss, {
	gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 180px), 1fr))',
	gap: 12,
})
const listCardCss = css({ flexDirection: 'row', alignItems: 'center' })
const compactArtCss = css({ aspectRatio: 'auto', padding: 16 })
const listBodyCss = css({
	flexDirection: 'row',
	alignItems: 'center',
	flexWrap: 'wrap',
	padding: 16,
	'& > p': { flex: '1 1 220px' },
})
const iconTileCss = css({ listStyle: 'none' })
const iconTileLinkCss = css({
	display: 'flex',
	flexDirection: 'column',
	alignItems: 'center',
	gap: 10,
	padding: 12,
	color: colors.text,
	textAlign: 'center',
	textDecoration: 'none',
	fontSize: 14,
	fontWeight: 600,
	overflowWrap: 'anywhere',
	borderRadius: 12,
	'&:hover': { background: colors.primarySoftest },
	'&:focus-visible': { outline: `2px solid ${colors.primary}` },
})
