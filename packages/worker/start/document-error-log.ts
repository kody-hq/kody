import { getRequestContext } from '../src/request-context.ts'

/**
 * Router turns a failed loader into a 500 page without throwing, so nothing
 * else logs why. Logs the error, never the page's data.
 */
export function logDocumentErrors(
	matches: Array<{ status: string; routeId: string; error?: unknown }>,
) {
	const d1 = getRequestContext()?.d1ReplicaReads?.session
		? 'a D1 replica session'
		: 'the D1 primary'
	for (const match of matches) {
		if (match.status !== 'error') continue
		const error = match.error
		console.error(
			`Document route ${match.routeId} failed while reading ${d1}:`,
			error instanceof Error
				? `${error.name}: ${error.message}\n${error.stack ?? ''}`
				: String(error),
		)
	}
}
