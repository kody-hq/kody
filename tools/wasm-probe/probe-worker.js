const { crypto, URL, Response, setTimeout, clearTimeout } = globalThis
// Probe parent Worker. Its only binding is the Worker Loader (LOADER). Each
// POST /<token>/run makes one call into one Dynamic Worker and reports the
// timing and result. Children get globalOutbound: null.
import { buildModule } from './wasm.js'
import {
	childCompatibilityDate,
	childCompatibilityFlags,
	token,
} from './config.js'

// Built fresh per load (never cached): the parent holds at most one large
// module at a time, like Kody's loader holding bytes read from R2.
function moduleBytes(padKind, mib) {
	return buildModule({ padKind, padBytes: Math.round(mib * 1048576) }).buffer
}

async function sha256Hex(buffer) {
	const digest = await crypto.subtle.digest('SHA-256', buffer)
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
}

const errorMessage = `(error) => 'error: ' + String((error && error.message) || error)`

const sources = {
	basic: (hash) => `
import mod from './lib/nested/add.wasm'
import rootRelative from './.__kody_wasm__/${hash}.wasm'
import bytes from './add.bin'
const describe = ${errorMessage}
const inst = new WebAssembly.Instance(mod, {})
export default {
	async fetch() {
		const out = {
			moduleIsWebAssemblyModule: mod instanceof WebAssembly.Module,
			nestedAdd: inst.exports.add(2, 3),
			rootRelativeAdd: new WebAssembly.Instance(rootRelative, {}).exports.add(2, 3),
			requestTime: {},
		}
		const tries = {
			'new WebAssembly.Module(bytes)': () => new WebAssembly.Module(bytes),
			'WebAssembly.compile(bytes)': () => WebAssembly.compile(bytes),
			'WebAssembly.instantiate(bytes)': () => WebAssembly.instantiate(bytes, {}),
			'WebAssembly.instantiate(importedModule)': () => WebAssembly.instantiate(mod, {}),
		}
		for (const [label, run] of Object.entries(tries)) {
			try {
				await run()
				out.requestTime[label] = 'ok'
			} catch (error) {
				out.requestTime[label] = describe(error)
			}
		}
		return Response.json(out)
	},
}
`,
	'tl-sync-bytes': () => `
import bytes from './add.bin'
const describe = ${errorMessage}
let result
try {
	const m = new WebAssembly.Module(bytes)
	result = 'ok: add=' + new WebAssembly.Instance(m, {}).exports.add(2, 3)
} catch (error) { result = describe(error) }
export default { fetch() { return Response.json({ result }) } }
`,
	'tl-await-module': () => `
import mod from './add.wasm'
const describe = ${errorMessage}
let result
try {
	const instance = await WebAssembly.instantiate(mod, {})
	result = 'ok: add=' + instance.exports.add(2, 3)
} catch (error) { result = describe(error) }
export default { fetch() { return Response.json({ result }) } }
`,
	'tl-await-bytes': () => `
import bytes from './add.bin'
const describe = ${errorMessage}
let result
try {
	const { instance } = await WebAssembly.instantiate(bytes, {})
	result = 'ok: add=' + instance.exports.add(2, 3)
} catch (error) { result = describe(error) }
export default { fetch() { return Response.json({ result }) } }
`,
	'tl-await-compile-bytes': () => `
import bytes from './add.bin'
const describe = ${errorMessage}
let result
try {
	const m = await WebAssembly.compile(bytes)
	result = 'ok: add=' + new WebAssembly.Instance(m, {}).exports.add(2, 3)
} catch (error) { result = describe(error) }
export default { fetch() { return Response.json({ result }) } }
`,
	size: () => `
import mod from './pad.wasm'
const inst = new WebAssembly.Instance(mod, {})
const held = [inst]
export default {
	fetch(request) {
		if (new URL(request.url).searchParams.has('hold')) {
			held.push(new WebAssembly.Instance(mod, {}))
		}
		return Response.json({
			add: inst.exports.add(2, 3),
			memoryBytes: inst.exports.memory.buffer.byteLength,
			held: held.length,
		})
	},
}
`,
	busy: (topIterations) => `
import mod from './busy.wasm'
const inst = new WebAssembly.Instance(mod, {})
const topResult = ${Number(topIterations) || 0} > 0 ? inst.exports.busy(${Number(topIterations) || 0}) : 0
export default {
	fetch(request) {
		const n = Number(new URL(request.url).searchParams.get('n') || 0)
		return Response.json({ topResult, result: n > 0 ? inst.exports.busy(n) : 0 })
	},
}
`,
	hello: () =>
		`export default { fetch() { return new Response('hello from a dynamic worker') } }`,
}

async function workerCode(spec) {
	const modules = {}
	if (spec.scenario === 'hello') {
		modules['main.js'] = sources.hello()
	} else if (spec.scenario === 'basic') {
		const add = moduleBytes('none', 0)
		const hash = await sha256Hex(add)
		modules['main.js'] = sources.basic(hash)
		modules['lib/nested/add.wasm'] = { wasm: moduleBytes('none', 0) }
		modules[`.__kody_wasm__/${hash}.wasm`] = { wasm: moduleBytes('none', 0) }
		modules['add.bin'] = { data: moduleBytes('none', 0) }
	} else if (spec.scenario.startsWith('tl-')) {
		modules['main.js'] = sources[spec.scenario]()
		modules['add.wasm'] = { wasm: moduleBytes('none', 0) }
		modules['add.bin'] = { data: moduleBytes('none', 0) }
	} else if (spec.scenario === 'size') {
		modules['main.js'] = sources.size()
		modules['pad.wasm'] = { wasm: moduleBytes(spec.padKind, spec.mib) }
	} else if (spec.scenario === 'busy') {
		modules['main.js'] = sources.busy(spec.topIterations)
		modules['busy.wasm'] = { wasm: moduleBytes('none', 0) }
	} else {
		throw new Error(`unknown scenario ${spec.scenario}`)
	}
	return {
		compatibilityDate: childCompatibilityDate,
		compatibilityFlags: childCompatibilityFlags,
		mainModule: 'main.js',
		modules,
		globalOutbound: null,
	}
}

function withTimeout(promise, ms) {
	let timer
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`timed out after ${ms} ms`)),
				ms,
			)
		}),
	]).finally(() => clearTimeout(timer))
}

async function run(env, spec) {
	let loadCalled = false
	let loadMs = null
	const started = Date.now()
	try {
		const stub = env.LOADER.get(spec.id, async () => {
			loadCalled = true
			const t0 = Date.now()
			const code = await workerCode(spec)
			loadMs = Date.now() - t0
			return code
		})
		const response = await withTimeout(
			stub.getEntrypoint().fetch(`https://child.invalid/${spec.query ?? ''}`),
			spec.timeoutMs ?? 20000,
		)
		const text = await response.text()
		let body = text
		try {
			body = JSON.parse(text)
		} catch {}
		return {
			ok: response.ok,
			status: response.status,
			ms: Date.now() - started,
			loadCalled,
			loadMs,
			body,
		}
	} catch (error) {
		return {
			ok: false,
			ms: Date.now() - started,
			loadCalled,
			loadMs,
			error: String((error && error.stack) || error).slice(0, 600),
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url)
		if (url.pathname !== `/${token}/run` || request.method !== 'POST') {
			return new Response('not found', { status: 404 })
		}
		return Response.json(await run(env, await request.json()))
	},
}
