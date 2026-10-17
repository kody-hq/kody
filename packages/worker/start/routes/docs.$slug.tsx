/** @jsxImportSource @emotion/react */
import { docMarkdown } from '#start/server/markdown'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { docHref, resolveLegacyDocSlug } from '#universal/docs-nav.ts'
import { DocDetailRoute } from '../pages/doc-detail.tsx'
import { documentHead } from '../components/document-head.ts'
import { loadDoc } from '#start/server/docs'
import { isPublicDocSlug } from '../page-access.ts'

const pageQuery = createPageQuery('loadDoc', loadDoc, {
	staleTime: 5 * 60_000,
	gcTime: 30 * 60_000,
	freshAuthorization: ({ slug }) => !isPublicDocSlug(slug),
})

export const Route = createFileRoute('/docs/$slug')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		motionGroup: 'docs',
		shell: { gutters: 'page' },
		sessionVerification: 'public-doc',
	},
	server: { middleware: [negotiatedDocument], handlers: { GET: docMarkdown } },
	context: ({ params }) => ({ pageQueryInput: { slug: params.slug } }),
	beforeLoad: ({ location, params }) => {
		const alias = resolveLegacyDocSlug(params.slug)
		if (alias.slug !== params.slug)
			throw redirect({
				href: `${docHref(alias.slug)}${location.searchStr}${alias.fragment ? `#${alias.fragment}` : location.hash ? `#${location.hash}` : ''}`,
				statusCode: 308,
				headers: { 'Cache-Control': 'public, max-age=3600' },
			})
	},
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Doc,
	notFoundComponent: NotFoundPage,
})
function Doc() {
	return <DocDetailRoute {...usePageData()} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
