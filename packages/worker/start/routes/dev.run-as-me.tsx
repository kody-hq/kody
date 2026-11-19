/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { RunAsMeMockPage } from '../pages/run-as-me-mock.tsx'
import { loadUiGallery } from '#start/server/ui-gallery'

export const Route = createFileRoute('/dev/run-as-me')({
	staticData: {
		shell: { mode: 'standalone', gutters: 'page' },
		sessionVerification: 'public',
	},
	validateSearch: (search: Record<string, unknown>) => ({
		declined: search.declined === true || search.declined === 1,
	}),
	loader: () => loadUiGallery(),
	head: () => ({
		meta: [
			{ title: 'Run as me (mockup)' },
			{ name: 'robots', content: 'noindex, nofollow' },
		],
	}),
	component: () => {
		const { declined } = Route.useSearch()
		return <RunAsMeMockPage declined={declined} />
	},
})
