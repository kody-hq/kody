import { createFileRoute } from '@tanstack/react-router'
import { createElement } from 'react'
import { staticDocumentHead } from '../components/document-head.ts'
import {
	packageAppDeviceSignInDocument,
	packageAppDeviceSignInPost,
	rejectPackageAppDeviceMethod,
} from '#start/server/package-app-device-protocol'
import { loadPackageAppDeviceSignIn } from '#start/server/package-app-device'
import { PackageAppDeviceSignInPage } from '../pages/package-app-device-sign-in.tsx'

export const Route = createFileRoute('/oauth/package-app/device')({
	server: {
		handlers: {
			GET: packageAppDeviceSignInDocument,
			HEAD: packageAppDeviceSignInDocument,
			POST: packageAppDeviceSignInPost,
			PUT: rejectPackageAppDeviceMethod,
			PATCH: rejectPackageAppDeviceMethod,
			DELETE: rejectPackageAppDeviceMethod,
			OPTIONS: rejectPackageAppDeviceMethod,
		},
	},
	staticData: {
		documentNavigation: true,
		sessionVerification: 'public',
		shell: { mode: 'focused' },
	},
	head: staticDocumentHead('packageAppDeviceSignIn'),
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) =>
		loadPackageAppDeviceSignIn({ data: location.searchStr }),
	component: Page,
})

function Page() {
	return createElement(PackageAppDeviceSignInPage, {
		data: Route.useLoaderData(),
	})
}
