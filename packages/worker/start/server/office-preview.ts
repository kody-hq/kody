import { getRequest } from '@tanstack/react-start/server'
import {
	officePreviewHtml,
	officePreviewPolicy,
	officePreviewPermissions,
} from '#universal/office-preview.ts'
export async function officePreviewHttp({
	params,
}: {
	params: { orgSlug: string; kind: string }
}) {
	const url = new URL(getRequest().url),
		script = url.searchParams.get('script') ?? ''
	const match =
		/^(?:\/__start\/[a-f0-9]{40})?\/office-viewers\/(docx|xlsx|pptx)-[a-f0-9]{12}\.js$/.exec(
			script,
		)
	if (
		!match ||
		match[1] !== params.kind ||
		!/^[a-zA-Z0-9_-]+$/.test(params.orgSlug)
	)
		return new Response('Not found', { status: 404 })
	// This inert sandbox contains no account data. Only its parent supplies bytes.
	return new Response(officePreviewHtml(url.origin, script), {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': officePreviewPolicy(url.origin, script),
			'Permissions-Policy': officePreviewPermissions,
			'Cache-Control': 'private, no-store',
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
			'X-Kody-Office-Preview': '1',
		},
	})
}
