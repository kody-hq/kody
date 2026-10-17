/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { ProfileRoute, ProfileUnavailable } from '../pages/profile.tsx'
import { documentHead } from '../components/document-head.ts'
import { loadProfile } from '#start/server/public-data'
import { OrgHomePage } from '../pages/org-home.tsx'
import { profileReadInput } from '../public-read-input.ts'

const pageQuery = createPageQuery('loadProfile', loadProfile, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/@{$username}')({
	staticData: {
		motionGroup: 'profile',
		navigation: { rail: 'workspace', item: 'overview' },
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
	if (orgHome) return <OrgHomePage org={orgHome} />
	if (!data) return <ProfileUnavailable />
	return <ProfileRoute data={data} currentHref={href} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
