/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { documentHead } from '../components/document-head.ts'
import { loadNotFoundPage } from '#start/server/error-page'

export const Route = createFileRoute('/404')({
	staticData: { shell: { gutters: 'page' } },
	loader: () => loadNotFoundPage(),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: NotFoundPage,
})
