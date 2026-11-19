/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { DevMockupsIndexPage } from '../pages/dev-mockups.tsx'
import { loadDevMockups } from '#start/server/dev-mockups'

export const Route = createFileRoute('/dev/mockups/')({
	staticData: {
		shell: { mode: 'standalone', gutters: 'page' },
		sessionVerification: 'public',
	},
	loader: () => loadDevMockups(),
	head: () => ({
		meta: [
			{ title: 'Mockups' },
			{ name: 'robots', content: 'noindex, nofollow' },
		],
	}),
	component: DevMockupsIndexPage,
})
