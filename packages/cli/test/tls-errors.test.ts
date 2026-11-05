import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localBridgeTlsCheckPath } from '../src/local-egress.js'
import { startLocalRuntimeBridge } from '../src/local-runtime-bridge.js'
import { runSecretHeader } from '../src/local-runtime-source.js'
import {
	certErrorCode,
	certErrorMessage,
	checkTlsCertificate,
	extraTrustedCertificates,
} from '../src/tls-errors.js'
import { startSelfSignedHttps } from './self-signed-https.js'

const trustFix = 'kody daemon env set NODE_OPTIONS=--use-system-ca'

test('the cert error code is found anywhere in the cause chain', () => {
	const fetchError = new TypeError('fetch failed', {
		cause: Object.assign(new Error('unable to get local issuer certificate'), {
			code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
		}),
	})
	assert.equal(certErrorCode(fetchError), 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
	assert.equal(
		certErrorCode(
			new Error('x', {
				cause: new Error('y', { cause: { code: 'CERT_HAS_EXPIRED' } }),
			}),
		),
		'CERT_HAS_EXPIRED',
	)
	assert.equal(
		certErrorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
		null,
	)
	assert.equal(certErrorCode('nope'), null)
})

test('each cert problem is named with its fix, and never with cert contents or env values', () => {
	process.env.NODE_EXTRA_CA_CERTS = '/secret/place/corp-ca.pem'
	try {
		for (const code of [
			'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
			'SELF_SIGNED_CERT_IN_CHAIN',
			'DEPTH_ZERO_SELF_SIGNED_CERT',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		]) {
			const message = certErrorMessage(code, 'api.example.com')
			assert.match(
				message,
				new RegExp(
					`^HTTPS request to api\\.example\\.com failed: .*\\(${code}: `,
				),
			)
			assert.ok(message.includes(trustFix), message)
			assert.match(message, /NODE_EXTRA_CA_CERTS=<path to the CA file>/)
			assert.doesNotMatch(
				message,
				/BEGIN CERTIFICATE|secret\/place|internal error/,
			)
		}
		const expired = certErrorMessage('CERT_HAS_EXPIRED', 'api.example.com')
		assert.match(expired, /\(CERT_HAS_EXPIRED: it has expired\)/)
		assert.match(expired, /has to be fixed on that server/)
		assert.ok(!expired.includes(trustFix))
	} finally {
		delete process.env.NODE_EXTRA_CA_CERTS
	}
})

test('extra trusted CAs follow --use-system-ca and NODE_EXTRA_CA_CERTS', () => {
	assert.deepEqual(extraTrustedCertificates({}, []), [])
	const system = extraTrustedCertificates(
		{ NODE_OPTIONS: '--use-system-ca' },
		[],
	)
	assert.ok(Array.isArray(system))
	for (const pem of system) assert.match(pem, /^-----BEGIN CERTIFICATE-----/)
	assert.deepEqual(
		extraTrustedCertificates({ NODE_OPTIONS: '--use-system-cache' }, []),
		[],
	)
})

test('the bridge names a self-signed cert behind the run secret, without its contents', async (t) => {
	const https = await startSelfSignedHttps('hi')
	if (!https) return t.skip('openssl is not installed')
	const bridge = await startLocalRuntimeBridge({
		runSecret: 'secret',
		forwardCall: async () => null,
		forwardGatewayFetchStream: async () => {},
	})
	try {
		assert.equal(
			await checkTlsCertificate({ host: '127.0.0.1', port: https.port }),
			'DEPTH_ZERO_SELF_SIGNED_CERT',
		)
		const check = (headers: Record<string, string>) =>
			fetch(`http://127.0.0.1:${bridge.port}${localBridgeTlsCheckPath}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify({ host: '127.0.0.1', port: https.port }),
			})
		assert.equal((await check({})).status, 403)
		const verdict = (await (
			await check({ [runSecretHeader]: 'secret' })
		).json()) as {
			message: string
		}
		assert.match(
			verdict.message,
			/DEPTH_ZERO_SELF_SIGNED_CERT: it is self-signed/,
		)
		assert.ok(verdict.message.includes(trustFix))
		assert.ok(!verdict.message.includes(https.certPem.split('\n')[1]!))
	} finally {
		await bridge.close()
		await new Promise((resolve) => https.server.close(resolve))
	}
})
