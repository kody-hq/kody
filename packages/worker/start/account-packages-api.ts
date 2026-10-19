import { readJsonApiResponse } from './read-json-api-response.ts'

export type AccountPackagesApiResult = {
	ok: boolean
	error?: string
	approvalUrl?: string
	packageId?: string
	deleted?: boolean
}

/**
 * POST `/account/packages.json` with resilient JSON parsing. Prefer typed Start
 * server functions for new UI; this remains for tooling and retained clients.
 */
export async function postAccountPackagesAction(
	body: Record<string, unknown>,
): Promise<AccountPackagesApiResult> {
	const response = await fetch('/account/packages.json', {
		method: 'POST',
		credentials: 'include',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
	const parsed = await readJsonApiResponse<AccountPackagesApiResult>(response)
	if (parsed.data && typeof parsed.data === 'object') {
		if (!parsed.ok || !parsed.data.ok) {
			throw Object.assign(
				new Error(
					parsed.data.error ||
						parsed.error ||
						(parsed.status === 401
							? 'Please sign in again.'
							: 'Unable to update this package.'),
				),
				{ approvalUrl: parsed.data.approvalUrl },
			)
		}
		return parsed.data
	}
	throw new Error(
		parsed.error ||
			(parsed.status === 401
				? 'Please sign in again.'
				: 'Unable to update this package.'),
	)
}
