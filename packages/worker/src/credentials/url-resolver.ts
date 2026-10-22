/**
 * The `url` credential kind (ADR 0068): the value is a whole HTTPS URL, such
 * as a chat webhook or a `https://api.telegram.org/bot<token>` base. Code
 * passes only a relative path and query, which the resolver appends; the
 * request always goes to the credential's own URL, on one of its hosts.
 */
import {
	assertHttpsUrl,
	credentialHostsAllow,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import { type CredentialResolver } from './credential-resolver.ts'
import {
	authorizeStoredCredential,
	findStoredCredential,
} from './stored-credential.ts'

export type ResolvedCredentialUrl = {
	url: URL
	/** Texts that carry the value, for echo redaction of the response. */
	substitutedValues: ReadonlyArray<string>
}

const schemePattern = /^[a-z][a-z0-9+.-]*:/i

function invalidPath(message: string): never {
	throw new CredentialRequestRefusedError('invalid_request', message)
}

/**
 * Splits a relative reference into the path to append and the query to add.
 * It may not name another origin or climb out of the credential's path.
 */
function readRelativePath(path: string) {
	const withoutFragment = path.split('#', 1)[0]!
	if (schemePattern.test(withoutFragment) || withoutFragment.startsWith('//')) {
		invalidPath(
			'A url credential takes a path relative to its own URL, not another URL.',
		)
	}
	if (withoutFragment.includes('\\')) {
		invalidPath('A url credential path cannot contain a backslash.')
	}
	const queryStart = withoutFragment.indexOf('?')
	const pathname =
		queryStart === -1 ? withoutFragment : withoutFragment.slice(0, queryStart)
	const query = queryStart === -1 ? '' : withoutFragment.slice(queryStart + 1)
	if (pathname && !pathname.startsWith('/')) {
		invalidPath('A url credential path starts with "/" (or is empty).')
	}
	const segments = pathname.split('/')
	if (
		segments.some((segment) => {
			const decoded = segment.toLowerCase().replaceAll('%2e', '.')
			return decoded === '.' || decoded === '..'
		})
	) {
		invalidPath('A url credential path cannot contain "." or ".." segments.')
	}
	return { pathname, query }
}

/** `base` with `path` appended to its path and its query added to the query. */
export function joinCredentialUrl(base: URL, path: string) {
	const { pathname, query } = readRelativePath(path)
	const url = new URL(base.href)
	url.hash = ''
	// URL.pathname is never empty: '', '/', and '?q' all arrive as '/' (or
	// '/?q'). Treat that bare '/' as "no path to append" so the stored URL
	// stays the source of truth; still append any query below.
	if (pathname && pathname !== '/') {
		url.pathname = `${url.pathname.replace(/\/+$/, '')}${pathname}`
	}
	if (query) {
		url.search = url.search ? `${url.search}&${query}` : `?${query}`
	}
	return url
}

function readCredentialUrl(value: string, hosts: ReadonlyArray<string>) {
	let base: URL
	try {
		base = new URL(value.trim())
	} catch {
		throw new CredentialRequestRefusedError(
			'invalid_request',
			'This url credential does not hold a valid URL. Its owner can replace the value.',
		)
	}
	assertHttpsUrl(base)
	if (base.username || base.password) {
		throw new CredentialRequestRefusedError(
			'invalid_request',
			'A url credential cannot carry a username or password in its URL.',
		)
	}
	if (!credentialHostsAllow(hosts, base.hostname)) {
		throw new CredentialRequestRefusedError(
			'host_not_allowed',
			"This url credential's URL is not on one of its hosts.",
		)
	}
	return base
}

/**
 * Strings the gateway redacts from errors and response URLs: the stored URL,
 * the request URL it was joined into, and the stored path and query on their
 * own, since joining puts the code's path between them.
 */
function echoedForms(value: string, base: URL, url: URL) {
	const forms = [
		value.trim(),
		base.href,
		url.href,
		`${base.origin}${base.pathname}`,
		base.pathname,
		base.search,
	]
	return [...new Set(forms.filter((form) => form.length >= 8))]
}

export const urlCredentialResolver: CredentialResolver<'url'> = {
	auditSubject: (credential) => ({
		use: credential.use,
		resourceType: 'secret',
		name: credential.credentialId,
		credentialId: null,
	}),
	async resolve(call) {
		const { credential } = call
		// Validate the code's half before anything is looked up or read.
		readRelativePath(credential.path)
		const lookup = await findStoredCredential(call, credential.credentialId)
		let hosts: ReadonlyArray<string> = []
		return {
			async authorize() {
				const found = await authorizeStoredCredential(
					call,
					credential.credentialId,
					lookup,
					'url',
				)
				hosts = found.allowedHosts
			},
			async apply(): Promise<ResolvedCredentialUrl> {
				// `authorize` returned, so the lookup found a usable credential.
				const value = await lookup!.readValue()
				const base = readCredentialUrl(value, hosts)
				const url = joinCredentialUrl(base, credential.path)
				call.subject.details = { host: url.hostname }
				return { url, substitutedValues: echoedForms(value, base, url) }
			},
		}
	},
	isFound: () => true,
}
