import { createFileRoute } from '@tanstack/react-router'
import { createElement } from 'react'
import { PackageAppRunConsentPage } from '../pages/package-app-run-consent.tsx'
import { loadPackageAppRunConsent } from '#start/server/package-app-run-consent'
import { postPackageAppRunConsent } from '#start/server/package-app-run-consent-protocol'

export const Route = createFileRoute('/oauth/package-app/run-as-me')({
	server: {
		handlers: {
			POST: ({ request }) => postPackageAppRunConsent({ request }),
		},
	},
	staticData: {
		documentNavigation: true,
		sessionVerification: 'public',
		shell: { mode: 'standalone', gutters: 'page' },
	},
	preload: false,
	loaderDeps: ({ search }) => search,
	loader: ({ location }) =>
		loadPackageAppRunConsent({ data: location.searchStr }),
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData?.declined
					? `${loaderData.appName} did not run`
					: 'Run as me',
			},
			{ name: 'robots', content: 'noindex, nofollow' },
		],
	}),
	component: () =>
		createElement(PackageAppRunConsentPage, Route.useLoaderData()),
})
