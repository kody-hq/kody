/** @jsxImportSource @emotion/react */
import { oauthCallbackFlowKey } from '../oauth-callback-navigation.ts'
import { connectOauthInput } from '../connect-input.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadConnectOauth } from '#start/server/connect'
import { ConnectOauthRoute } from '../pages/connect-oauth.tsx'
import { documentHead } from '../components/document-head.ts'
export const Route = createFileRoute('/connect/oauth')({
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => search,
	loader: ({ abortController, location }) =>
		loadConnectOauth({
			signal: abortController.signal,
			data: connectOauthInput(location.searchStr),
		}),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const { pageLocation: location } = Route.useRouteContext()
	const href = location.href
	return (
		<ConnectOauthRoute
			key={oauthCallbackFlowKey(location)}
			flowKey={oauthCallbackFlowKey(location)!}
			currentHref={href}
			initialData={Route.useLoaderData().payload}
		/>
	)
}
