/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { LoginPage } from '../pages/login.tsx'
import { loadAuthPage } from '#start/server/auth-page'
export const Route = createFileRoute('/signup')({
	staticData: { anonymousDocumentCache: 'marketing', shell: { mode: 'auth' } },
	head: staticDocumentHead('signup'),
	loaderDeps: ({ search }) => search,
	loader: ({ abortController, location }) =>
		loadAuthPage({
			signal: abortController.signal,
			data: {
				redirectTo: new URLSearchParams(location.searchStr).get('redirectTo'),
			},
		}),
	component: AuthPage,
})
function AuthPage() {
	const data = Route.useLoaderData()
	const { pageLocation: location } = Route.useRouteContext()
	return (
		<LoginPage
			key={location.href}
			mode="signup"
			currentHref={location.href}
			authConfig={data.authConfig}
		/>
	)
}
