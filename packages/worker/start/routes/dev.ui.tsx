/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { UiGalleryPage } from '../pages/ui-gallery.tsx'
import { loadUiGallery } from '#start/server/ui-gallery'

export const Route = createFileRoute('/dev/ui')({
	staticData: {
		shell: { mode: 'standalone', gutters: 'page' },
		sessionVerification: 'public',
	},
	loader: () => loadUiGallery(),
	head: () => ({
		meta: [
			{ title: 'UI gallery' },
			{ name: 'robots', content: 'noindex, nofollow' },
		],
	}),
	component: UiGalleryPage,
})
