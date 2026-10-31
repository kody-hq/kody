/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadPageQuery, usePageQuery } from '../page-query.ts'
import { ProfilesRoute } from '../pages/profiles.tsx'
import {
	profilesPageQuery as pageQuery,
	validateProfilesSearch,
} from '../profiles-query.ts'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/profiles')({
	validateSearch: validateProfilesSearch,
	loaderDeps: ({ search }) => ({ members: search.members }),
	staticData: {
		workspaceSwitch: { section: 'profiles' },
		navigation: { rail: 'workspace', item: 'profiles' },
		orgScope: { section: 'profiles' },
	},
	loader: ({ context, preload, params, deps }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, {
				orgSlug: params.orgSlug,
				...(deps.members ? { members: deps.members } : {}),
			}),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const params = Route.useParams()
	const search = Route.useSearch()
	const { actorKey, pageLocation } = Route.useRouteContext()
	const { payload } = usePageQuery(
		pageQuery(actorKey, {
			orgSlug: params.orgSlug,
			...(search.members ? { members: search.members } : {}),
		}),
	).data
	return <ProfilesRoute payload={payload} currentHref={pageLocation.href} />
}
