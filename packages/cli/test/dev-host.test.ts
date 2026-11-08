import assert from 'node:assert/strict'
import type { NetworkInterfaceInfo } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { runCli } from '../src/cli.js'
import {
	assertDevHostAllowed,
	devHostExposureWarning,
	devLanAddresses,
	isLoopbackDevHost,
	parseDevHost,
	planDevListen,
} from '../src/dev/dev-host.js'
import { resolveAllowedDevHost } from '../src/dev/dev-proxy-origin.js'
import { StructuredCliError } from '../src/structured-error.js'
import { withDevServer } from './dev-server-harness.js'

function iface(
	address: string,
	family: 'IPv4' | 'IPv6',
	internal = false,
): NetworkInterfaceInfo {
	return {
		address,
		family,
		internal,
		netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::',
		mac: '00:00:00:00:00:00',
		cidr: null,
		...(family === 'IPv6' ? { scopeid: 0 } : {}),
	} as NetworkInterfaceInfo
}

const fakeInterfaces = {
	lo: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
	docker0: [iface('172.17.0.1', 'IPv4')],
	en0: [
		iface('192.168.1.20', 'IPv4'),
		iface('fe80::1c2b:3cff:fe4d:5e6f', 'IPv6'),
		iface('fd00::20', 'IPv6'),
	],
}

test('parseDevHost accepts IP literals and localhost, rejects the rest', () => {
	assert.equal(parseDevHost('0.0.0.0'), '0.0.0.0')
	assert.equal(parseDevHost(' 192.168.1.20 '), '192.168.1.20')
	assert.equal(parseDevHost('::'), '::')
	assert.equal(parseDevHost('[FD00::20]'), 'fd00::20')
	assert.equal(parseDevHost('LOCALHOST'), 'localhost')
	for (const bad of [
		'',
		'evil.example',
		'0.0.0.0:4100',
		'http://0.0.0.0',
		'256.1.1.1',
		'fe80::1%en0',
	]) {
		assert.throws(
			() => parseDevHost(bad),
			(error: unknown) =>
				error instanceof StructuredCliError && error.code === 'invalid_host',
			bad,
		)
	}
})

test('isLoopbackDevHost covers 127/8, ::1, and localhost only', () => {
	assert.equal(isLoopbackDevHost('127.0.0.1'), true)
	assert.equal(isLoopbackDevHost('127.1.2.3'), true)
	assert.equal(isLoopbackDevHost('::1'), true)
	assert.equal(isLoopbackDevHost('[::1]'), true)
	assert.equal(isLoopbackDevHost('localhost'), true)
	assert.equal(isLoopbackDevHost('0.0.0.0'), false)
	assert.equal(isLoopbackDevHost('::'), false)
	assert.equal(isLoopbackDevHost('192.168.1.20'), false)
})

test('devLanAddresses lists own non-internal addresses, LAN first', () => {
	assert.deepEqual(devLanAddresses('0.0.0.0', fakeInterfaces), [
		'192.168.1.20',
		'172.17.0.1',
	])
	assert.deepEqual(devLanAddresses('::', fakeInterfaces), [
		'192.168.1.20',
		'172.17.0.1',
		'fd00::20',
	])
	assert.deepEqual(devLanAddresses('192.168.1.20', fakeInterfaces), [
		'192.168.1.20',
	])
	assert.deepEqual(devLanAddresses('127.0.0.1', fakeInterfaces), [])
})

test('planDevListen: loopback default is unchanged', () => {
	const plan = planDevListen({
		bindHost: '127.0.0.1',
		port: 4777,
		interfaces: () => fakeInterfaces,
	})
	assert.equal(plan.hostedUrl, 'http://127.0.0.1:4777')
	assert.equal(plan.localUrl, 'http://127.0.0.1:4777')
	assert.deepEqual(plan.networkUrls, [])
	assert.deepEqual(plan.extraAllowedHosts(), [])
})

test('planDevListen: 0.0.0.0 serves the LAN URL and allows only own addresses', () => {
	const plan = planDevListen({
		bindHost: '0.0.0.0',
		port: 4777,
		interfaces: () => fakeInterfaces,
	})
	assert.equal(plan.hostedUrl, 'http://192.168.1.20:4777')
	assert.equal(plan.localUrl, 'http://127.0.0.1:4777')
	assert.deepEqual(plan.networkUrls, [
		'http://192.168.1.20:4777',
		'http://172.17.0.1:4777',
	])
	const allow = (incomingHost: string) =>
		resolveAllowedDevHost({
			incomingHost,
			trustedHost: new URL(plan.hostedUrl).host,
			aliases: plan.extraAllowedHosts(),
		})
	assert.equal(allow('192.168.1.20:4777'), '192.168.1.20:4777')
	assert.equal(allow('172.17.0.1:4777'), '172.17.0.1:4777')
	assert.equal(allow('127.0.0.1:4777'), '127.0.0.1:4777')
	assert.equal(allow('LOCALHOST:4777'), 'localhost:4777')
	assert.equal(allow('192.168.1.21:4777'), null)
	assert.equal(allow('192.168.1.20:4778'), null)
	assert.equal(allow('192.168.1.20'), null)
	assert.equal(allow('evil.example:4777'), null)
	assert.equal(allow('0.0.0.0:4777'), null)
})

test('planDevListen: :: brackets IPv6 and re-reads interfaces per request', () => {
	let interfaces: typeof fakeInterfaces | Record<string, never> = {}
	const plan = planDevListen({
		bindHost: '::',
		port: 4777,
		interfaces: () => interfaces,
	})
	assert.equal(plan.hostedUrl, 'http://[::1]:4777')
	assert.deepEqual(plan.networkUrls, [])
	interfaces = fakeInterfaces
	assert.ok(plan.extraAllowedHosts().includes('[fd00::20]:4777'))
	assert.ok(plan.extraAllowedHosts().includes('192.168.1.20:4777'))
})

test('planDevListen: a specific LAN IP is its own URL', () => {
	const plan = planDevListen({
		bindHost: '192.168.1.20',
		port: 4777,
		interfaces: () => fakeInterfaces,
	})
	assert.equal(plan.hostedUrl, 'http://192.168.1.20:4777')
	assert.equal(plan.localUrl, 'http://192.168.1.20:4777')
	assert.deepEqual(plan.networkUrls, ['http://192.168.1.20:4777'])
})

test('non-loopback --host with --target prod needs --expose-prod', () => {
	assertDevHostAllowed({
		bindHost: '0.0.0.0',
		target: 'mock',
		exposeProd: false,
	})
	assertDevHostAllowed({
		bindHost: '127.0.0.1',
		target: 'prod',
		exposeProd: false,
	})
	assertDevHostAllowed({ bindHost: '::', target: 'prod', exposeProd: true })
	assert.throws(
		() =>
			assertDevHostAllowed({
				bindHost: '0.0.0.0',
				target: 'prod',
				exposeProd: false,
			}),
		(error: unknown) =>
			error instanceof StructuredCliError &&
			error.code === 'dev_host_prod_refused' &&
			/--expose-prod/.test(error.fix ?? ''),
	)
})

test('devHostExposureWarning only fires for non-loopback binds', () => {
	assert.equal(
		devHostExposureWarning({ bindHost: '127.0.0.1', target: 'mock' }),
		null,
	)
	const mock = devHostExposureWarning({ bindHost: '0.0.0.0', target: 'mock' })
	assert.match(mock ?? '', /every device on your network/)
	assert.match(mock ?? '', /Anyone who can reach this port can use the app/)
	assert.match(mock ?? '', /--target prod it would act with your real Kody/)
	const prod = devHostExposureWarning({ bindHost: '0.0.0.0', target: 'prod' })
	assert.match(prod ?? '', /acts with your real Kody credentials/)
})

async function cliStderr(argv: Array<string>) {
	let stderr = ''
	const code = await runCli(argv, {
		stdout: () => {},
		stderr: (text) => {
			stderr += text
		},
	})
	return { code, stderr }
}

test('kody dev --host is validated before anything starts', async () => {
	const bad = await cliStderr(['dev', '--host', 'evil.example'])
	assert.notEqual(bad.code, 0)
	assert.match(bad.stderr, /--host must be an IP address/)

	const prod = await cliStderr(['dev', '--host', '0.0.0.0', '--target', 'prod'])
	assert.notEqual(prod.code, 0)
	assert.match(prod.stderr, /Refusing --host 0\.0\.0\.0 with --target prod/)

	const fetch = await cliStderr(['dev', 'fetch', '/', '--host', '0.0.0.0'])
	assert.notEqual(fetch.code, 0)
	assert.match(fetch.stderr, /--host` applies to `kody dev serve` only/)

	const orphan = await cliStderr(['dev', '--expose-prod'])
	assert.notEqual(orphan.code, 0)
	assert.match(orphan.stderr, /--expose-prod` only applies together/)
})

const originAppEntry = `export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST') {
      const origin = request.headers.get('origin')
      return new Response(origin === url.origin ? 'ok' : 'csrf', {
        status: origin === url.origin ? 200 : 403,
      })
    }
    return Response.json({ origin: url.origin, host: request.headers.get('host') })
  },
}
`

function requestVia(
	port: number,
	input: { host: string; method?: string; origin?: string },
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: '127.0.0.1',
				port,
				path: '/',
				method: input.method ?? 'GET',
				headers: {
					host: input.host,
					...(input.origin ? { origin: input.origin } : {}),
				},
			},
			(res) => {
				const chunks: Array<Buffer> = []
				res.on('data', (chunk) => chunks.push(chunk))
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf8'),
					}),
				)
			},
		)
		req.on('error', reject)
		req.end()
	})
}

test('kody dev --host 0.0.0.0 serves LAN Hosts with a matching origin and rejects unknown Hosts', async () => {
	await withDevServer(
		async ({ server }) => {
			assert.equal(server.localUrl, `http://127.0.0.1:${server.port}`)
			const local = await requestVia(server.port, {
				host: `127.0.0.1:${server.port}`,
			})
			assert.equal(local.status, 200)
			assert.equal(
				(JSON.parse(local.body) as { origin: string }).origin,
				`http://127.0.0.1:${server.port}`,
			)

			const evil = await requestVia(server.port, {
				host: `evil.example:${server.port}`,
			})
			assert.equal(evil.status, 400)
			assert.match(evil.body, /Unrecognized Host/)

			const lanOrigin = server.networkUrls[0]
			if (!lanOrigin) return
			assert.equal(server.hostedUrl, lanOrigin)
			const lanHost = new URL(lanOrigin).host
			const lan = await requestVia(server.port, { host: lanHost })
			assert.equal(lan.status, 200)
			const body = JSON.parse(lan.body) as { origin: string; host: string }
			assert.equal(body.origin, lanOrigin)
			assert.equal(body.host, lanHost)

			const csrfOk = await requestVia(server.port, {
				host: lanHost,
				method: 'POST',
				origin: lanOrigin,
			})
			assert.equal(csrfOk.status, 200)
			const csrfCross = await requestVia(server.port, {
				host: lanHost,
				method: 'POST',
				origin: 'http://evil.example',
			})
			assert.equal(csrfCross.status, 403)
		},
		{
			host: '0.0.0.0',
			prepare: async (root) => {
				await writeFile(join(root, 'app/entry.ts'), originAppEntry)
			},
		},
	)
})
