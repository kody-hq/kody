import { oauthCallbackDocument } from '#start/server/oauth-protocol'
/** @jsxImportSource @emotion/react */
import { staticDocumentHead } from '../components/document-head.ts'
import { createFileRoute } from '@tanstack/react-router'
import { OAuthCallbackRoute } from '../pages/oauth-callback.tsx'

export const Route = createFileRoute('/oauth/callback')({
	staticData: { documentNavigation: true },
	server: {
		handlers: { GET: oauthCallbackDocument, HEAD: oauthCallbackDocument },
	},
	head: staticDocumentHead('oauthCallback'),
	component: OAuthCallbackRoute,
})
