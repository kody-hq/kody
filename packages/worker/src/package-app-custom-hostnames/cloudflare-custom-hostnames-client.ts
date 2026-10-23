import {
	CloudflareApiError,
	CloudflareRestClient,
} from '#worker/mcp/cloudflare/cloudflare-rest-client.ts'

/**
 * Zone SSL and Certificates Edit token for Cloudflare for SaaS custom
 * hostnames (`CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN`). This is not
 * `CLOUDFLARE_API_TOKEN`. `PACKAGE_APP_ZONE_ID` is the SaaS zone id
 * (staging proof or production `kody.run` once SaaS is enabled there).
 */
export type CloudflareCustomHostnamesClientEnv = {
	CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN?: string
	PACKAGE_APP_ZONE_ID?: string
	fetcher?: Fetcher
}

export type CustomHostnameSslMethod = 'http' | 'txt'

export type CustomHostnameDnsRecord = {
	type: string
	name: string
	value: string
}

export type CloudflareCustomHostnameResult = {
	id: string
	hostname: string
	hostnameStatus: string
	sslStatus: string | null
	ownershipVerification: CustomHostnameDnsRecord | null
	sslValidationRecords: Array<CustomHostnameDnsRecord>
	/**
	 * Cloudflare's latest reasons the hostname or certificate is not active
	 * yet (`verification_errors` plus `ssl.validation_errors`). Empty when
	 * Cloudflare reports none.
	 */
	verificationErrors: Array<string>
}

type CustomHostnameApiResult = {
	id?: unknown
	hostname?: unknown
	status?: unknown
	ownership_verification?: {
		type?: unknown
		name?: unknown
		value?: unknown
	} | null
	ownership_verification_http?: {
		http_url?: unknown
		http_body?: unknown
	} | null
	verification_errors?: unknown
	ssl?: {
		status?: unknown
		validation_errors?: unknown
		validation_records?: Array<{
			txt_name?: unknown
			txt_value?: unknown
			http_url?: unknown
			http_body?: unknown
		}> | null
	} | null
}

type CustomHostnameApiEnvelope = {
	success?: unknown
	errors?: Array<{ message?: unknown; code?: unknown }>
	result?: CustomHostnameApiResult | null
}

function requireToken(token: string | undefined) {
	const trimmed = token?.trim() ?? ''
	if (!trimmed) {
		throw new Error(
			'CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN is not set. Mint a zone-limited token with Zone SSL and Certificates Edit for the package-app SaaS zone (#3612). Do not reuse CLOUDFLARE_API_TOKEN.',
		)
	}
	return trimmed
}

function requireZoneId(zoneId: string | undefined) {
	const trimmed = zoneId?.trim() ?? ''
	if (!trimmed) {
		throw new Error(
			'PACKAGE_APP_ZONE_ID is not set. Point it at the package-app SaaS zone. Do not assume the production kody.run zone without enabling Cloudflare for SaaS there.',
		)
	}
	if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
		throw new Error('PACKAGE_APP_ZONE_ID must be a Cloudflare zone id.')
	}
	return trimmed
}

function assertCustomHostnameId(id: string) {
	const trimmed = id.trim()
	// Reject path, query, and fragment delimiters so URL construction cannot
	// reinterpret a malformed id as a different Cloudflare resource.
	if (!trimmed || /[/?#]/.test(trimmed) || trimmed.includes('..')) {
		throw new Error('Custom hostname id is invalid.')
	}
	return trimmed
}

function readDnsRecord(input: {
	type?: unknown
	name?: unknown
	value?: unknown
}): CustomHostnameDnsRecord | null {
	const type = typeof input.type === 'string' ? input.type.trim() : ''
	const name = typeof input.name === 'string' ? input.name.trim() : ''
	const value = typeof input.value === 'string' ? input.value.trim() : ''
	if (!type || !name || !value) return null
	return { type, name, value }
}

function readSslValidationRecords(
	ssl: CustomHostnameApiResult['ssl'],
): Array<CustomHostnameDnsRecord> {
	const records = ssl?.validation_records
	if (!Array.isArray(records)) return []
	const out: Array<CustomHostnameDnsRecord> = []
	for (const record of records) {
		const txtName =
			typeof record.txt_name === 'string' ? record.txt_name.trim() : ''
		const txtValue =
			typeof record.txt_value === 'string' ? record.txt_value.trim() : ''
		if (txtName && txtValue) {
			out.push({ type: 'txt', name: txtName, value: txtValue })
		}
		const httpUrl =
			typeof record.http_url === 'string' ? record.http_url.trim() : ''
		const httpBody =
			typeof record.http_body === 'string' ? record.http_body.trim() : ''
		if (httpUrl && httpBody) {
			out.push({ type: 'http', name: httpUrl, value: httpBody })
		}
	}
	return out
}

const maxVerificationErrors = 5
const maxVerificationErrorLength = 300

function readVerificationErrors(
	result: CustomHostnameApiResult,
): Array<string> {
	const out: Array<string> = []
	const push = (value: unknown) => {
		const text = typeof value === 'string' ? value.trim() : ''
		if (!text || out.includes(text)) return
		out.push(text.slice(0, maxVerificationErrorLength))
	}
	if (Array.isArray(result.verification_errors)) {
		for (const entry of result.verification_errors) push(entry)
	}
	const sslErrors = result.ssl?.validation_errors
	if (Array.isArray(sslErrors)) {
		for (const entry of sslErrors) {
			push(
				entry && typeof entry === 'object'
					? (entry as { message?: unknown }).message
					: entry,
			)
		}
	}
	return out.slice(0, maxVerificationErrors)
}

function readCustomHostnameResult(
	body: unknown,
	status: number,
): CloudflareCustomHostnameResult {
	const envelope = body as CustomHostnameApiEnvelope | null
	if (!envelope || envelope.success !== true || !envelope.result) {
		const message =
			typeof envelope?.errors?.[0]?.message === 'string'
				? envelope.errors[0].message
				: `Cloudflare custom hostname request failed (${status}).`
		throw new CloudflareApiError(message, { status })
	}
	const result = envelope.result
	if (typeof result.id !== 'string' || !result.id) {
		throw new CloudflareApiError(
			`Cloudflare custom hostname response did not include an id (${status}).`,
			{ status },
		)
	}
	const hostname = typeof result.hostname === 'string' ? result.hostname : ''
	const hostnameStatus = typeof result.status === 'string' ? result.status : ''
	const sslStatus =
		typeof result.ssl?.status === 'string' ? result.ssl.status : null
	const ownershipTxt = result.ownership_verification
		? readDnsRecord(result.ownership_verification)
		: null
	const ownershipHttp = readOwnershipVerificationHttp(
		result.ownership_verification_http,
	)
	return {
		id: result.id,
		hostname,
		hostnameStatus,
		sslStatus,
		// Prefer TXT ownership; fall back to HTTP ownership when CF omits TXT.
		ownershipVerification: ownershipTxt ?? ownershipHttp,
		sslValidationRecords: readSslValidationRecords(result.ssl),
		verificationErrors: readVerificationErrors(result),
	}
}

function readOwnershipVerificationHttp(
	input: CustomHostnameApiResult['ownership_verification_http'],
): CustomHostnameDnsRecord | null {
	if (!input) return null
	const httpUrl =
		typeof input.http_url === 'string' ? input.http_url.trim() : ''
	const httpBody =
		typeof input.http_body === 'string' ? input.http_body.trim() : ''
	if (!httpUrl || !httpBody) return null
	return { type: 'http', name: httpUrl, value: httpBody }
}

export class CloudflareCustomHostnamesClient {
	private readonly client: CloudflareRestClient
	private readonly zoneId: string

	constructor(env: CloudflareCustomHostnamesClientEnv) {
		this.zoneId = requireZoneId(env.PACKAGE_APP_ZONE_ID)
		this.client = new CloudflareRestClient({
			apiToken: requireToken(env.CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN),
			fetcher: env.fetcher,
		})
	}

	private collectionPath() {
		return `/client/v4/zones/${this.zoneId}/custom_hostnames`
	}

	private hostnamePath(id: string) {
		return `${this.collectionPath()}/${assertCustomHostnameId(id)}`
	}

	async addCustomHostname(input: {
		hostname: string
		sslMethod?: CustomHostnameSslMethod
	}): Promise<CloudflareCustomHostnameResult> {
		const hostname = input.hostname.trim().toLowerCase()
		if (!hostname) {
			throw new Error('hostname is required to add a custom hostname.')
		}
		const sslMethod = input.sslMethod ?? 'http'
		switch (sslMethod) {
			case 'http':
			case 'txt':
				break
			default: {
				sslMethod satisfies never
				throw new Error('sslMethod must be http or txt.')
			}
		}
		const response = await this.client.rawRequest({
			method: 'POST',
			path: this.collectionPath(),
			body: {
				hostname,
				ssl: {
					method: sslMethod,
					type: 'dv',
				},
			},
		})
		return readCustomHostnameResult(response.body, response.status)
	}

	async getCustomHostname(input: {
		id: string
	}): Promise<CloudflareCustomHostnameResult | { alreadyGone: true }> {
		const response = await this.client.rawRequest({
			method: 'GET',
			path: this.hostnamePath(input.id),
		})
		// Cloudflare maps missing custom hostnames to HTTP 404 + error code 1436.
		if (isMissingCustomHostname404(response)) {
			return { alreadyGone: true }
		}
		return readCustomHostnameResult(response.body, response.status)
	}

	/**
	 * Delete a custom hostname. Cloudflare 404 + code 1436 (or a non-JSON 404
	 * from an intermediary) means it is already gone — treat as success so
	 * local cleanup can proceed. Other 404s still surface as API errors.
	 */
	async deleteCustomHostname(input: {
		id: string
	}): Promise<CloudflareCustomHostnameResult | { alreadyGone: true }> {
		try {
			const response = await this.client.rawRequest({
				method: 'DELETE',
				path: this.hostnamePath(input.id),
			})
			if (isMissingCustomHostname404(response) || response.status === 404) {
				// Idempotent delete: any 404 after a successful parse path means gone.
				// Prefer 1436 when present; bare 404 still allows local cleanup.
				return { alreadyGone: true }
			}
			return readCustomHostnameResult(response.body, response.status)
		} catch (error) {
			if (error instanceof CloudflareApiError && error.status === 404) {
				return { alreadyGone: true }
			}
			throw error
		}
	}
}

function isMissingCustomHostname404(input: {
	status: number
	body: unknown | null
}): boolean {
	if (input.status !== 404) return false
	const envelope = input.body as CustomHostnameApiEnvelope | null
	if (!envelope || !Array.isArray(envelope.errors)) return false
	return envelope.errors.some((error) => Number(error?.code) === 1436)
}

export function isCloudflareCustomHostnameGone(
	value: CloudflareCustomHostnameResult | { alreadyGone: true },
): value is { alreadyGone: true } {
	return 'alreadyGone' in value && value.alreadyGone === true
}
