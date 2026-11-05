import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A self-signed HTTPS server on 127.0.0.1, or null when openssl is missing. */
export async function startSelfSignedHttps(
	body: string,
): Promise<{ server: Server; port: number; certPem: string } | null> {
	const dir = mkdtempSync(join(tmpdir(), 'kody-tls-'))
	try {
		const made = spawnSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-keyout',
				join(dir, 'key.pem'),
				'-out',
				join(dir, 'cert.pem'),
				'-days',
				'2',
				'-subj',
				'/CN=localhost',
				'-addext',
				'subjectAltName=DNS:localhost,IP:127.0.0.1',
			],
			{ stdio: 'ignore' },
		)
		if (made.status !== 0) return null
		const certPem = readFileSync(join(dir, 'cert.pem'), 'utf8')
		const server = createServer(
			{ key: readFileSync(join(dir, 'key.pem')), cert: certPem },
			(_request, response) => response.end(body),
		)
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		return { server, port: (server.address() as AddressInfo).port, certPem }
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}
