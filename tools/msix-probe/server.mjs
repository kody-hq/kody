import { createServer } from 'node:http'
import { createServer as createTls } from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.argv[2]
const state = { version: process.env.PROBE_VERSION_1 }
const log = []
function handler(proto, port) {
	return (req, res) => {
		const url = new URL(req.url, `${proto}://localhost:${port}`)
		log.push(`${proto} ${req.method} ${url.pathname} range=${req.headers.range ?? ''} ua=${req.headers['user-agent'] ?? ''}`)
		if (url.pathname === '/__set') {
			state.version = url.searchParams.get('v')
			return res.end('ok')
		}
		if (url.pathname === '/__log') return res.end(log.join('\n'))
		const [, variant, hop, name] = url.pathname.match(/^\/(\w+)(\/hop)?\/(.+)$/) ?? []
		if (!variant) return res.writeHead(404).end()
		const base = `${proto}://localhost:${port}/${variant}`
		if (variant === 'redirect' && !hop) {
			return res.writeHead(302, { location: `${base}/hop/${name}`, 'content-type': 'text/html; charset=utf-8' }).end()
		}
		if (variant === 'redirect' && hop) {
			return res.writeHead(302, { location: `${proto}://localhost:${port}/octet/${name}`, 'content-type': 'text/html; charset=utf-8' }).end()
		}
		const octet = variant === 'octet'
		let body
		let type
		if (name.endsWith('.appinstaller')) {
			const arch = process.env.PROBE_ARCH
			const v = `${state.version}.0`
			const self = process.env.PROBE_SELF_BASE ? `${proto}://localhost:${port}/${process.env.PROBE_SELF_BASE}` : base
			body = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<AppInstaller Uri="${self}/Kody-win-${arch}.appinstaller" Version="${v}" xmlns="http://schemas.microsoft.com/appx/appinstaller/2018">
  <MainPackage Name="KodyCodes.Kody" Publisher="CN=Kody Desktop CI" Version="${v}" ProcessorArchitecture="${arch}" Uri="${self}/Kody-${state.version}-win-${arch}.msix" />
  <UpdateSettings><OnLaunch HoursBetweenUpdateChecks="0" /></UpdateSettings>
</AppInstaller>
`)
			type = octet ? 'application/octet-stream' : 'application/appinstaller'
		} else {
			const file = join(dir, name)
			if (!existsSync(file)) return res.writeHead(404).end()
			body = readFileSync(file)
			type = octet ? 'application/octet-stream' : 'application/msix'
		}
		const headers = { 'content-type': type, 'accept-ranges': 'bytes' }
		if (octet) headers['content-disposition'] = `attachment; filename=${name}`
		const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/)
		if (range) {
			const start = Number(range[1])
			const end = range[2] ? Number(range[2]) : body.length - 1
			res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 })
			return res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1))
		}
		res.writeHead(200, { ...headers, 'content-length': body.length })
		res.end(req.method === 'HEAD' ? undefined : body)
	}
}
createServer(handler('http', 8080)).listen(8080)
createTls({ pfx: readFileSync(process.env.PROBE_TLS_PFX), passphrase: 'probe' }, handler('https', 8443)).listen(8443)
console.log('listening')
