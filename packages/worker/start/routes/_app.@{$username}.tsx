/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { ProfileRoute, ProfileUnavailable } from '../pages/profile.tsx'
import { documentHead } from '../components/document-head.ts'
import { loadProfile } from '#start/server/public-data'
import { OrgHomePage } from '../pages/org-home.tsx'
import { profileReadInput } from '../public-read-input.ts'
import { orgHomeHref, orgHomeView } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'

const pageQuery = createPageQuery('loadProfile', loadProfile, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/_app/@{$username}')({
	staticData: {
		presentationSearchKeys: [
			'q',
			'sort',
			'dir',
			'visibility',
			'listing',
			'hidden',
			'app',
			'package',
			'view',
		],
		workspaceLayout: 'profile',
		navigation: { rail: 'workspace', item: 'public-profile' },
		shell: { gutters: 'page' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }: { search: Record<string, unknown> }) => ({
		limit: search.limit,
		q: search.limit != null ? search.q : undefined,
	}),
	context: ({ location, params }) => ({
		pageQueryInput: profileReadInput(params.username, location.searchStr),
	}),
	shouldReload: ({ context }) => !context.inPlaceNavigation,
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) =>
		loaderData
			? documentHead(loaderData.head)
			: { meta: [{ title: 'Profile unavailable' }] },
	component: Profile,
	notFoundComponent: ProfileUnavailable,
})
function Profile() {
	const { data, orgHome } = usePageData()
	const href = Route.useRouteContext().pageLocation.href
	const view = new URL(href, 'https://kody.local').searchParams.get('view')
	// A public team org shows its public page to everyone; members open the
	// org home with `?view=home`. Private orgs only have the home.
	if (orgHome && (!data || view === orgHomeView))
		return (
			<OrgHomePage
				org={orgHome}
				publicPageHref={
					data ? routes.profile.href({ username: orgHome.slug }) : null
				}
			/>
		)
	if (!data) return <ProfileUnavailable />
	return (
		<ProfileRoute
			data={data}
			currentHref={href}
			orgHomeHref={orgHome ? orgHomeHref(orgHome.slug) : null}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
