import { startPrivateCandidateTail } from './start-opt-in-diagnostics.ts'
import { reviewedRouterName } from './start-rollout-config.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { workerEvidence } from './start-opt-in-cloudflare.ts'
import { isExecutedDirectly, resolveLocalBinary } from '../node-runtime.ts'

type Review = {
	manifest: {
		release: string
		candidateName: string
		legacyName: string
		routerName?: string
		assetPaths: Array<string>
	}
}
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}
export async function inspectHealthResponse(response: Response, lane: string) {
	const type = response.headers.get('X-Probe-Content-Type') ?? ''
	const category = response.headers.get('X-Probe-Error-Class') ?? 'unknown'
	const knownCategory = [
		'none',
		'native-error-page',
		'cloudflare-1101',
		'cloudflare-1102',
		'unknown-error',
	].includes(category)
		? category
		: 'unknown'
	const context = `${lane} health (status ${response.status}, JSON content type ${/^application\/json(?:;|$)/i.test(type)}, error ${knownCategory}, commit header ${response.headers.get('X-Probe-Commit-Present') === 'true'})`
	assert(response.status === 200, `${context} failed`)
	assert(
		/^application\/json(?:;|$)/i.test(type),
		`${context} did not return JSON`,
	)
	let result: { ok?: boolean; commitSha?: string }
	try {
		result = (await response.json()) as typeof result
	} catch {
		throw new Error(`${context} returned invalid JSON`)
	}
	assert(
		result !== null &&
			typeof result === 'object' &&
			result.ok === true &&
			typeof result.commitSha === 'string',
		`${context} is not healthy`,
	)
	return result.commitSha
}
export function inspectPublicDocument(
	html: string,
	release: string,
	expectStart: boolean,
	lane = 'public',
) {
	const title = /<title\b([^>]*)>([\s\S]*?)<\/title>/i.exec(html)
	const shape = {
		doctype: /<!doctype\s+html\b/i.test(html),
		html: /<html\b/i.test(html),
		head: /<head\b/i.test(html),
		body: /<body\b/i.test(html),
		title: Boolean(title),
		titleAttributes: Boolean(title?.[1]?.trim()),
		titleText: Boolean(title?.[2]?.trim()),
	}
	assert(
		shape.doctype && shape.titleText,
		`${lane} public document is not complete HTML: ${JSON.stringify(shape)}`,
	)
	assert(
		html.includes(`/__start/${release}/`) === expectStart,
		expectStart
			? 'Start document lacks its exact release namespace'
			: 'A default legacy document unexpectedly selected Start',
	)
}
async function port() {
	const server = createServer()
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	assert(address && typeof address === 'object', 'Loopback port unavailable')
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	)
	return address.port
}

if (isExecutedDirectly(import.meta.url)) {
	const reviewPath = process.argv[2] ?? '.tmp/start-opt-in/review.json'
	// Failed re-verification must not leave an older success proof available.
	await rm('.tmp/start-opt-in/runtime-proof.json', { force: true })
	const review = JSON.parse(await readFile(reviewPath, 'utf8')) as Review
	const { release, candidateName, legacyName, assetPaths } = review.manifest
	assert(
		/^[a-f0-9]{40}$/.test(release) &&
			candidateName === `kody-start-${release}` &&
			legacyName === 'kody-production',
		'Pinned deployment review bundle required',
	)
	const routerName = reviewedRouterName(release, review.manifest.routerName)
	const css = assetPaths.find((asset) => asset.endsWith('.css'))
	const script = assetPaths.find((asset) => asset.endsWith('.js'))
	assert(css && script, 'Emitted CSS and JavaScript asset paths are required')
	const reservedChunk = assetPaths.find(
		(asset) => asset.endsWith('.js') && asset.includes('@'),
	)
	assert(reservedChunk, 'An emitted reserved-character route chunk is required')
	const sampledAssets = [css, script, reservedChunk]
	const versions = {
		candidate: await workerEvidence(candidateName),
		router: await workerEvidence(routerName),
	}
	const directory = await mkdtemp(path.join(tmpdir(), 'kody-start-probe-'))
	let child: ChildProcess | undefined
	let ended = false
	let stopTail = () => {}
	try {
		stopTail = startPrivateCandidateTail(release, candidateName)
		const key = randomBytes(32).toString('hex')
		const localPort = await port()
		const config = {
			name: `kody-start-probe-${release.slice(0, 12)}`,
			main: path.resolve('tools/ci/start-opt-in-probe-worker.ts'),
			compatibility_date: '2026-04-16',
			workers_dev: false,
			preview_urls: false,
			services: [
				{ binding: 'START', service: candidateName },
				{ binding: 'LEGACY', service: legacyName },
				{ binding: 'ROUTER', service: routerName },
			],
			vars: {
				START_RELEASE: release,
				ASSET_PATHS: JSON.stringify(sampledAssets),
				PROBE_KEY: key,
			},
		}
		const configPath = path.join(directory, 'wrangler.json')
		await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
		child = spawn(
			resolveLocalBinary('wrangler'),
			[
				'dev',
				'--remote',
				'--config',
				configPath,
				'--ip',
				'127.0.0.1',
				'--port',
				String(localPort),
				'--local-protocol',
				'http',
				'--log-level',
				'error',
			],
			{ stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
		)
		// Remote preview URLs and tokens must never be copied into logs or artifacts.
		child.stdout?.resume()
		child.stderr?.resume()
		child.once('error', () => {
			ended = true
		})
		child.once('close', () => {
			ended = true
		})
		const fetchProbe = (route: string) =>
			fetch(`http://127.0.0.1:${localPort}${route}`, {
				headers: { 'X-Kody-Probe-Key': key },
				redirect: 'manual',
				signal: AbortSignal.timeout(15_000),
			})
		let ready = false
		const deadline = Date.now() + 45_000
		while (!ended && Date.now() < deadline) {
			try {
				const response = await fetchProbe('/unknown')
				ready = response.status === 404
				if (ready) break
			} catch {
				/* Wait for the loopback listener. */
			}
			await new Promise((resolve) => setTimeout(resolve, 250))
		}
		assert(ready, 'Temporary remote service probe did not start')
		const health = async (lane: string) =>
			inspectHealthResponse(await fetchProbe(`/${lane}/health`), lane)

		assert(
			(await health('start')) === release,
			'Candidate health does not match exact source release',
		)
		const legacySha = await health('legacy')
		assert(
			(await health('router')) === legacySha,
			'Default router health is not legacy',
		)
		for (const lane of ['start', 'legacy', 'router']) {
			const response = await fetchProbe(`/${lane}/document`)
			assert(response.status === 200, `${lane} public document failed`)
			inspectPublicDocument(
				await response.text(),
				release,
				lane === 'start',
				lane,
			)
		}
		const invalid = await fetchProbe('/router/invalid-preference')
		assert(
			invalid.status === 200,
			'Invalid preference did not retain the legacy app',
		)
		inspectPublicDocument(
			await invalid.text(),
			release,
			false,
			'router-invalid-preference',
		)
		for (const route of ['/router/opt-in', '/router/rpc'])
			assert(
				(await fetchProbe(route)).status === 403,
				`Anonymous outsider was not denied at ${route}`,
			)
		assert(
			(await fetchProbe('/router/unknown-asset')).status === 404,
			'Unknown release asset was not denied',
		)
		for (const asset of sampledAssets) {
			const expected = await readFile(
				path.join('dist/client/__start', release, asset),
			)
			for (const [lane, encoded] of [
				['start', ''],
				['router', ''],
				['router', '&encoded=1'],
			]) {
				const response = await fetchProbe(
					`/${lane}/asset?path=${encodeURIComponent(asset)}${encoded}`,
				)
				assert(response.status === 200, `${lane} emitted asset failed`)
				const type = response.headers.get('X-Probe-Content-Type') ?? ''
				assert(
					asset.endsWith('.css')
						? type.includes('text/css')
						: /javascript/.test(type),
					`${lane} asset has incorrect content type`,
				)
				const bytes = Buffer.from(await response.arrayBuffer())
				assert(
					createHash('sha256').update(bytes).digest('hex') ===
						createHash('sha256').update(expected).digest('hex'),
					`${lane} asset does not match pinned build`,
				)
			}
		}
		const after = {
			candidate: await workerEvidence(candidateName),
			router: await workerEvidence(routerName),
		}
		assert(
			JSON.stringify(after) === JSON.stringify(versions),
			'Inactive workers changed during private runtime verification',
		)
		const proof = {
			release,
			candidateName,
			routerName,
			checkedAt: new Date().toISOString(),
			versions,
			legacySha,
			health: 'passed',
			publicDocuments: 'passed',
			exactAssets: 'passed',
			anonymousDenial: 'passed',
			invalidPreference: 'legacy',
			activated: false,
		}
		await writeFile(
			'.tmp/start-opt-in/runtime-proof.json',
			JSON.stringify(proof, null, '\t'),
		)
		console.log(JSON.stringify(proof))
	} finally {
		stopTail()
		child?.kill('SIGTERM')
		await new Promise<void>((resolve) => {
			if (!child || ended) resolve()
			else {
				child.once('close', () => resolve())
				setTimeout(() => {
					child?.kill('SIGKILL')
					resolve()
				}, 3000).unref()
			}
		})
		await rm(directory, { recursive: true, force: true })
	}
}
