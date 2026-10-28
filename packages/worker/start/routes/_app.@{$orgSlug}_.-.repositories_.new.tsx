/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadRepositoryCreatePage } from '#start/server/repositories'
import { documentHead } from '../components/document-head.ts'
import { RepositoryCreatePage } from '../pages/repository-create.tsx'
const pageQuery = createPageQuery(
	'loadRepositoryCreatePage',
	loadRepositoryCreatePage,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/_app/@{$orgSlug}_/-/repositories_/new')({
	staticData: {
		workspaceSwitch: { section: 'repositories', suffix: ['new'] },
		navigation: { rail: 'workspace', item: 'repositories' },
		orgScope: { section: 'repositories' },
	},
	context: ({ params }) => ({
		pageQueryInput: { orgSlug: params.orgSlug },
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})

function Page() {
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	const { data } = usePageQuery(pageQuery(actorKey, pageQueryInput))
	return (
		<RepositoryCreatePage
			key={`${actorKey}:${pageQueryInput.orgSlug}`}
			payload={data.payload}
			orgSlug={pageQueryInput.orgSlug}
			currentHref={pageLocation.href}
		/>
	)
}
