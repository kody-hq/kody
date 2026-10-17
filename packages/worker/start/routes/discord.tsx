/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadDiscord } from '#start/server/discord'
import { DiscordPage } from '../pages/discord.tsx'

const pageQuery = createPageQuery('loadDiscord', loadDiscord)

export const Route = createFileRoute('/discord')({
	context: () => ({ pageQueryInput: undefined }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	staleTime: 0,
	head: () => ({ meta: [{ title: 'Discord' }] }),
	component: Discord,
})
function Discord() {
	const page = usePageData()
	const href = Route.useRouteContext().pageLocation.href
	return <DiscordPage page={page} currentHref={href} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
