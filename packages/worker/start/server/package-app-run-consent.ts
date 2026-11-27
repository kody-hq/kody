import { redirect, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { getStartRequestEnv } from './request-env.ts'
import { z } from 'zod'

export const loadPackageAppRunConsent = createServerFn({ method: 'GET' })
	.validator(
		z.string().refine((search) => search === '' || search.startsWith('?')),
	)
	.handler(async ({ data }) => {
		const [{ loadPackageAppRunConsentView }, { packageAppRunConsentPath }] =
			await Promise.all([
				import('./package-app-run-consent-protocol.ts'),
				import('../../src/app-visit/run-consent-url.ts'),
			])
		const request = getRequest()
		const url = new URL(packageAppRunConsentPath, request.url)
		url.search = data
		setResponseHeader('Cache-Control', 'private, no-store')
		setResponseHeader('Referrer-Policy', 'same-origin')
		const view = await loadPackageAppRunConsentView(
			new Request(url, { headers: request.headers }),
			getStartRequestEnv(),
		)
		if (view instanceof Response) {
			const location = view.headers.get('Location')
			if (location) throw redirect({ href: location, reloadDocument: true })
			throw notFound()
		}
		if (!view.declined && !view.needsConsent) {
			throw redirect({ href: view.destination, reloadDocument: true })
		}
		return {
			appName: view.appName,
			publisherName: view.publisherName,
			publisherUsername: view.publisherUsername,
			viewerName: view.viewerName,
			declined: view.declined,
			packageId: view.packageId,
			publisherId: view.publisherId,
			personId: view.personId,
			formAction: `${url.pathname}${url.search}`,
		}
	})
