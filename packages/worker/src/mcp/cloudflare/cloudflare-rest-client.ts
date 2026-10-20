/**
 * Minimal Cloudflare API v4 HTTP client (Bearer token) for internal Worker-side
 * Cloudflare API calls and tests. User-facing Cloudflare API access is via
 * saved package exports and secret-aware `fetch`; see
 * `docs/contributing/execute-patterns/cloudflare-api-v4.md`.
 *
 * @see https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/
 */

export function assertSafeCloudflareApiV4Path(path: string) {
	const trimmed = path.trim()
	if (!trimmed.startsWith('/')) {
		throw new Error(
			'path must start with `/` and must not include a host (for example use `/client/v4/accounts`, not a full URL).',
		)
	}
	if (!trimmed.startsWith('/client/v4/')) {
		throw new Error(
			'path must start with `/client/v4/` — see https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/',
		)
	}
	if (trimmed.includes('..')) {
		throw new Error('path must not contain `..` segments.')
	}
	if (/[\s#]/.test(trimmed)) {
		throw new Error('path contains disallowed characters.')
	}
	if (trimmed.length > 2048) {
		throw new Error('path exceeds maximum length.')
	}
}

export type CloudflareRestClientOptions = {
	apiToken: string
	baseUrl?: string
	userAgent?: string
	fetcher?: Fetcher
}

export class CloudflareApiError extends Error {
	readonly status: number
	constructor(message: string, options: { status: number; cause?: unknown }) {
		super(message, { cause: options.cause })
		this.name = 'CloudflareApiError'
		this.status = options.status
	}
}

const defaultUserAgent = 'kody-cloudflare-rest/1.0'
const defaultBaseUrl = 'https://api.cloudflare.com'

function assertSafeCloudflareApiBase(baseUrl: string) {
	let url: URL
	try {
		url = new URL(baseUrl)
	} catch {
		throw new Error(`Invalid Cloudflare API base URL: ${baseUrl}`)
	}
	if (
		url.hostname.toLowerCase() === 'api.cloudflare.com' &&
		url.protocol !== 'https:'
	) {
		throw new Error('Cloudflare API base URL must use HTTPS.')
	}
}

export class CloudflareRestClient {
	private readonly apiToken: string
	private readonly baseUrl: string
	private readonly userAgent: string
	private readonly fetcher: Fetcher | undefined

	constructor(options: CloudflareRestClientOptions) {
		this.apiToken = options.apiToken.trim()
		this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, '')
		assertSafeCloudflareApiBase(this.baseUrl)
		this.userAgent = options.userAgent?.trim() || defaultUserAgent
		this.fetcher = options.fetcher
	}

	async rawRequest(input: {
		method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
		path: string
		query?: Record<string, string>
		body?: unknown
	}): Promise<{
		status: number
		body: unknown | null
		cfRay: string | null
	}> {
		assertSafeCloudflareApiV4Path(input.path)
		const pathPart = input.path.startsWith('/') ? input.path : `/${input.path}`
		const url = new URL(`${this.baseUrl}${pathPart}`)
		if (input.query) {
			for (const [key, value] of Object.entries(input.query)) {
				url.searchParams.set(key, value)
			}
		}

		const headers: Record<string, string> = {
			accept: 'application/json',
			authorization: `Bearer ${this.apiToken}`,
			'user-agent': this.userAgent,
		}

		const init: RequestInit = {
			method: input.method,
			headers,
		}

		if (
			input.body !== undefined &&
			(input.method === 'POST' ||
				input.method === 'PUT' ||
				input.method === 'PATCH' ||
				input.method === 'DELETE')
		) {
			headers['content-type'] = 'application/json'
			init.body = JSON.stringify(input.body)
		}

		const response = await (this.fetcher?.fetch(url.toString(), init) ??
			fetch(url.toString(), init))
		const text = await response.text()
		const cfRay = response.headers.get('cf-ray')

		if (response.status === 204 || !text.trim()) {
			return { status: response.status, body: null, cfRay }
		}

		try {
			return {
				status: response.status,
				body: JSON.parse(text) as unknown,
				cfRay,
			}
		} catch {
			throw new CloudflareApiError(
				`Cloudflare API returned non-JSON (${response.status}).`,
				{ status: response.status },
			)
		}
	}
}

export function createCloudflareRestClient(
	env: Pick<Env, 'CLOUDFLARE_API_TOKEN' | 'CLOUDFLARE_API_BASE_URL'> & {
		CLOUDFLARE_API_MOCK?: Fetcher
	},
): CloudflareRestClient {
	const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
	if (!apiToken) {
		throw new Error(
			'CLOUDFLARE_API_TOKEN is not set. For local dev, run `npm run dev` so the Cloudflare mock sets a token, or configure a Cloudflare API token from the Cloudflare dashboard.',
		)
	}
	const baseUrl = env.CLOUDFLARE_API_BASE_URL?.trim() || defaultBaseUrl
	return new CloudflareRestClient({
		apiToken,
		baseUrl,
		fetcher: env.CLOUDFLARE_API_MOCK,
	})
}
