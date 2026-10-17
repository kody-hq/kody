import { AdminOperationError } from '#worker/admin/operation-result.ts'

/** Capture domain success or authorization/validation failure without routing an HTTP request. */
export async function adminOperationOutcome(run: () => Promise<unknown>) {
	try {
		return { status: 200, data: await run() }
	} catch (error) {
		if (error instanceof AdminOperationError)
			return { status: error.status, data: error.data }
		// Shared authorization utilities expose denial as Response for all transports.
		if (error instanceof Response)
			return { status: error.status, data: await error.json() }
		throw error
	}
}
