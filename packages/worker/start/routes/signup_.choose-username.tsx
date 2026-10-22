/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadSignupChooseUsernamePage } from '#start/server/signup-choose-username'
import { SignupChooseUsernamePage } from '../pages/signup-choose-username.tsx'

export const Route = createFileRoute('/signup_/choose-username')({
	// Personalized: email, provider identity, and CSRF must not be publicly cached.
	staticData: { shell: { mode: 'auth' } },
	loader: ({ abortController }) =>
		loadSignupChooseUsernamePage({ signal: abortController.signal }),
	head: () => ({ meta: [{ title: 'Choose your username' }] }),
	component: ChooseUsernameRoute,
})

function ChooseUsernameRoute() {
	const data = Route.useLoaderData()
	return (
		<SignupChooseUsernamePage
			csrf={data.csrf}
			suggestedUsername={data.suggestedUsername}
			email={data.email}
			provider={data.provider}
			providerUsername={data.providerUsername}
			displayName={data.displayName}
		/>
	)
}
