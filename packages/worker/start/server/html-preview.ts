import { getRequest } from '@tanstack/react-start/server'
import {
	htmlPreviewCsp,
	htmlPreviewPermissions,
	htmlPreviewBootstrap,
} from '#universal/html-preview.ts'

export async function htmlPreviewHttp({
	params,
}: {
	params: { orgSlug: string }
}) {
	const request = getRequest()
	const url = new URL(request.url)
	if (!/^[a-zA-Z0-9_-]+$/.test(params.orgSlug))
		return new Response('Not found', { status: 404 })
	// This inert sandbox contains no account data. Only its parent supplies bytes.
	return new Response(htmlPreviewBootstrap(url.origin), {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'private, no-store',
			'Content-Security-Policy': htmlPreviewCsp,
			'Permissions-Policy': htmlPreviewPermissions,
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
			'X-Kody-Isolated-Preview': '1',
		},
	})
}
