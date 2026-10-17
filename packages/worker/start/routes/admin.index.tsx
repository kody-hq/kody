/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadAdminIndex } from '#start/server/admin-index'

export const Route = createFileRoute('/admin/')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'users' },
	},
	head: staticDocumentHead('admin'),
	preload: false,
	shouldReload: true,
	loader: ({ location }) =>
		loadAdminIndex({
			data: { returnTo: location.pathname + location.searchStr },
		}),
	component: () => <p>Forbidden</p>,
})
