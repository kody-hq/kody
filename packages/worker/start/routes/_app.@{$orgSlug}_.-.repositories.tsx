/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgRepositories } from '#start/server/org-management'
import {
	AccountManagementShell,
	AccountPageHeader,
} from '../pages/account-management-components.tsx'
import { ProfileRoute } from '../pages/profile.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
const pageQuery = createPageQuery('loadOrgRepositories', loadOrgRepositories, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/repositories')({
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
		],
		workspaceSwitch: { section: 'repositories' },
		navigation: { rail: 'workspace', item: 'repositories' },
		orgScope: { section: 'repositories' },
		shell: { gutters: 'page' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => ({
		limit: search.limit,
		q: search.limit != null ? search.q : undefined,
	}),
	beforeLoad: ({ params, location }) => ({
		pageQueryInput: {
			slug: params.orgSlug,
			...repositoryInput(location.searchStr),
		},
	}),
	shouldReload: ({ context }) => !context.inPlaceNavigation,
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: () => ({ meta: [{ title: 'Repositories' }] }),
	component: Page,
})
function Page() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const { data } = usePageQuery(pageQuery(actorKey, pageQueryInput))
	const href = Route.useRouteContext().pageLocation.href
	const { orgSlug } = Route.useParams()
	return (
		<AccountManagementShell layout="list" currentHref={href}>
			<AccountPageHeader
				entity="repositories"
				title="Repositories"
				description="Every repository in this workspace, private ones included. Packages live here too: a package is a repository with a Kody package manifest. Your public profile shows visitors the public ones."
				currentHref={href}
				actions={
					<>
						<SiteLink
							href={routes.community.href(null, {
								searchParams: new URLSearchParams({ org: orgSlug }),
							})}
							css={getGhostButtonCss({ size: 'sm' })}
							data-testid="repositories-browse-community"
						>
							Fork a community package
						</SiteLink>
						<SiteLink
							href={routes.orgRepositoryNew.href({ orgSlug })}
							css={getPillButtonCss({ size: 'sm' })}
							data-testid="repositories-new"
						>
							New repository
						</SiteLink>
					</>
				}
			/>
			<ProfileRoute
				data={data}
				currentHref={href}
				basePath={new URL(href, 'https://kody.local').pathname}
			/>
		</AccountManagementShell>
	)
}

function repositoryInput(search: string) {
	const params = new URLSearchParams(search)
	const parsed = Number.parseInt(params.get('limit') ?? '', 10)
	return {
		query: params.has('limit') ? (params.get('q') ?? '').trim() : '',
		limit:
			Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : undefined,
	}
}
