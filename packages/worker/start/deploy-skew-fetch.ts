/**
 * Start `serverFns.fetch` wrapper that recovers from deploy version skew
 * before a stale client can deserialize a newer loader/server-fn payload.
 */

import {
	createDeploySkewRecoveryError,
	readClientBuildId,
	reloadOnDeploySkew,
} from '#client/reload-on-deploy-skew.ts'
import {
	deploySkewBuildHeader,
	isDeploySkewMismatch,
} from '#universal/deploy-skew.ts'
import { getRouterInstance } from '@tanstack/react-start'

async function navigationHref(): Promise<string> {
	try {
		const router: { latestLocation: { href: string } } =
			await getRouterInstance()
		return router.latestLocation.href
	} catch {
		if (typeof window === 'undefined') return '/'
		return `${window.location.pathname}${window.location.search}${window.location.hash}`
	}
}

/**
 * Client `serverFns.fetch` wrapper: compare `X-Kody-Build` to the boot meta,
 * hard-navigate on mismatch, then always throw a named recovery error so the
 * newer payload never reaches route components (including sibling in-flight
 * fetches after the one-shot navigate flag is set). No-ops when either build
 * id is missing (local/dev) or they match.
 */
export async function fetchWithDeploySkewCheck(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const response = await fetch(input, init)
	const serverBuild = response.headers.get(deploySkewBuildHeader)
	if (!serverBuild || !isDeploySkewMismatch(readClientBuildId(), serverBuild)) {
		return response
	}
	const href = await navigationHref()
	reloadOnDeploySkew({ serverBuild, href })
	throw createDeploySkewRecoveryError()
}
