import { createFileRoute } from '@tanstack/react-router'
import { createElement } from 'react'
import { staticDocumentHead } from '../components/document-head.ts'
import {
	accountDeviceSignInDocument,
	accountDeviceSignInPost,
	rejectAccountDeviceMethod,
} from '#start/server/account-device-protocol'
import { loadAccountDeviceSignIn } from '#start/server/account-device'
import { AccountDeviceSignInPage } from '../pages/account-device-sign-in.tsx'

export const Route = createFileRoute('/login_/device')({
	server: {
		handlers: {
			GET: accountDeviceSignInDocument,
			HEAD: accountDeviceSignInDocument,
			POST: accountDeviceSignInPost,
			PUT: rejectAccountDeviceMethod,
			PATCH: rejectAccountDeviceMethod,
			DELETE: rejectAccountDeviceMethod,
			OPTIONS: rejectAccountDeviceMethod,
		},
	},
	staticData: {
		documentNavigation: true,
		sessionVerification: 'public',
		shell: { mode: 'focused' },
	},
	head: staticDocumentHead('accountDeviceSignIn'),
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) =>
		loadAccountDeviceSignIn({ data: location.searchStr }),
	component: Page,
})

function Page() {
	return createElement(AccountDeviceSignInPage, {
		data: Route.useLoaderData(),
	})
}
