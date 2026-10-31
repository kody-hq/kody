/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { NativeAuth } from '../components/native-auth.tsx'
import { LoginPage } from '../pages/login.tsx'
import { loadAuthPage } from '#start/server/auth-page'
import { loginDocumentPost } from '#start/server/auth-document-protocol'
export const Route = createFileRoute('/login')({
	server: { handlers: { POST: loginDocumentPost } },
	staticData: { anonymousDocumentCache: 'marketing', shell: { mode: 'auth' } },
	head: staticDocumentHead('login'),
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
		<NativeAuth mode="login">
			<LoginPage
				key={location.href}
				mode="login"
				currentHref={location.href}
				authConfig={data.authConfig}
			/>
		</NativeAuth>
	)
}
