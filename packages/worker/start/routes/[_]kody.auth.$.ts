import { createFileRoute } from '@tanstack/react-router'
import { packageAppOauthHostAuth } from '#start/server/package-app-oauth-protocol'
export const Route = createFileRoute('/_kody/auth/$')({
	server: {
		handlers: {
			GET: packageAppOauthHostAuth,
			HEAD: packageAppOauthHostAuth,
			POST: packageAppOauthHostAuth,
			PUT: packageAppOauthHostAuth,
			PATCH: packageAppOauthHostAuth,
			DELETE: packageAppOauthHostAuth,
			OPTIONS: packageAppOauthHostAuth,
		},
	},
})
