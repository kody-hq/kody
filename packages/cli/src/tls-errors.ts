import { isIP } from 'node:net'
import * as tls from 'node:tls'

/** Why a certificate failed, by Node/OpenSSL code. Never includes cert contents. */
const certProblems: Record<string, { why: string; trust: boolean }> = {
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: {
		why: 'its issuer is not trusted on this machine',
		trust: true,
	},
	UNABLE_TO_GET_ISSUER_CERT: {
		why: 'its issuer certificate could not be found',
		trust: true,
	},
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
		why: 'its signature could not be verified against a trusted CA',
		trust: true,
	},
	SELF_SIGNED_CERT_IN_CHAIN: {
		why: 'the chain ends in a self-signed CA this machine does not trust',
		trust: true,
	},
	DEPTH_ZERO_SELF_SIGNED_CERT: {
		why: 'it is self-signed',
		trust: true,
	},
	CERT_UNTRUSTED: { why: 'it is not trusted', trust: true },
	CERT_HAS_EXPIRED: { why: 'it has expired', trust: false },
	CERT_NOT_YET_VALID: { why: 'it is not valid yet', trust: false },
	CERT_REVOKED: { why: 'it was revoked', trust: false },
	CERT_SIGNATURE_FAILURE: { why: 'its signature is invalid', trust: false },
	ERR_TLS_CERT_ALTNAME_INVALID: {
		why: 'it is not issued for this host name',
		trust: false,
	},
	HOSTNAME_MISMATCH: {
		why: 'it is not issued for this host name',
		trust: false,
	},
}

export function isCertErrorCode(code: unknown): code is string {
	return typeof code === 'string' && code in certProblems
}

/** The certificate error code anywhere in an error's cause chain. */
export function certErrorCode(error: unknown): string | null {
	let current: unknown = error
	for (let depth = 0; current && depth < 5; depth++) {
		const code = (current as { code?: unknown }).code
		if (isCertErrorCode(code)) return code
		current = (current as { cause?: unknown }).cause
	}
	return null
}

/** A caller-facing explanation naming the cert problem and the fix. */
export function certErrorMessage(code: string, host: string) {
	const problem = certProblems[code] ?? {
		why: 'it could not be verified',
		trust: true,
	}
	const fix = problem.trust
		? 'If a corporate proxy or custom CA intercepts TLS on this machine, trust it: `kody daemon env set NODE_OPTIONS=--use-system-ca` (or NODE_EXTRA_CA_CERTS=<path to the CA file>), then `kody daemon restart`. For `kody execute --local`, set the same variable in your shell.'
		: `The certificate ${host} serves has to be fixed on that server (or the proxy in between).`
	return `HTTPS request to ${host} failed: its TLS certificate could not be verified (${code}: ${problem.why}). ${fix}`
}

/** Node's verdict on a host's certificate, with the CAs this process trusts. */
export function checkTlsCertificate(input: {
	host: string
	port: number
	timeoutMs?: number
}): Promise<string | null> {
	return new Promise((resolve) => {
		const socket = tls.connect({
			host: input.host,
			port: input.port,
			...(isIP(input.host) ? {} : { servername: input.host }),
			rejectUnauthorized: false,
		})
		const done = (code: string | null) => {
			socket.destroy()
			resolve(code)
		}
		socket.setTimeout(input.timeoutMs ?? 5_000, () => done(null))
		socket.once('error', () => done(null))
		socket.once('secureConnect', () => {
			if (socket.authorized) return done(null)
			const error = socket.authorizationError as
				| (Error & { code?: string })
				| string
				| null
			const code = typeof error === 'string' ? error : (error?.code ?? null)
			if (code && code !== 'ERR_TLS_CERT_ALTNAME_INVALID') return done(code)
			const identity = tls.checkServerIdentity(
				input.host,
				socket.getPeerCertificate(),
			) as (Error & { code?: string }) | undefined
			done(identity?.code ?? code)
		})
	})
}

/**
 * CAs workerd should trust beyond its built-in browser set: the system store
 * under `--use-system-ca`, and NODE_EXTRA_CA_CERTS. Mirrors what Node trusts.
 */
export function extraTrustedCertificates(
	env: NodeJS.ProcessEnv = process.env,
	execArgv: Array<string> = process.execArgv,
): Array<string> {
	const get = (
		tls as unknown as {
			getCACertificates?: (type: 'system' | 'extra') => Array<string>
		}
	).getCACertificates
	if (typeof get !== 'function') return []
	const useSystem =
		execArgv.includes('--use-system-ca') ||
		/(^|\s)--use-system-ca(\s|$)/.test(env.NODE_OPTIONS ?? '')
	const certs: Array<string> = []
	try {
		if (useSystem) certs.push(...get('system'))
		if (env.NODE_EXTRA_CA_CERTS) certs.push(...get('extra'))
	} catch {
		return []
	}
	return [...new Set(certs)]
}
