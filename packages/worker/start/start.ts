import { applyDocumentPolicies } from '#start/server/document-policy'
import { protocolCsrf } from '../src/app/cross-origin-protection.ts'
import {
	createCsrfMiddleware,
	createMiddleware,
	createStart,
	getRouterInstance,
} from '@tanstack/react-start'
import {
	markRpcResponsePrivate,
	verifyBrowserDocument,
} from '#start/server/document-actor'
import { readDocumentActor } from './document-actor.ts'
import {
	documentActorHeader,
	documentDestinationHeader,
} from './session-identity.ts'

const documentIdentity = createMiddleware({ type: 'function' })
	.client(async ({ next }) => {
		if (typeof document === 'undefined') return next()
		const actor = readDocumentActor()
		const router: { latestLocation: { href: string } } =
			await getRouterInstance()
		return next({
			headers: {
				[documentActorHeader]: actor,
				[documentDestinationHeader]: router.latestLocation.href,
			},
		})
	})
	.server(async ({ next }) => {
		await verifyBrowserDocument()
		return next()
	})

const rpcResponsePolicy = createMiddleware().server(({ handlerType, next }) => {
	if (handlerType === 'serverFn') markRpcResponsePrivate()
	return next()
})

const documentPolicies = createMiddleware().server(
	({ request, handlerType, next }) => {
		if (handlerType === 'serverFn') return next()
		return applyDocumentPolicies(request, async () => next())
	},
)

export const startInstance = createStart(() => ({
	requestMiddleware: [
		rpcResponsePolicy,
		protocolCsrf,
		documentPolicies,
		createCsrfMiddleware({
			filter: ({ handlerType }) => handlerType === 'serverFn',
		}),
	],
	functionMiddleware: [documentIdentity],
}))
