import { createFileRoute } from '@tanstack/react-router'
import { accountPackagesHttp } from '#start/server/protocol-handlers'

export const Route = createFileRoute('/account_/packages.json')({
	server: {
		handlers: {
			GET: accountPackagesHttp,
			HEAD: accountPackagesHttp,
			POST: accountPackagesHttp,
		},
	},
})
