import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import { type AddressInfo } from 'node:net'
import path from 'node:path'

/**
 * Git smart HTTP for the local mock Artifacts API (`npm run dev`).
 *
 * The mock Cloudflare worker only stores repo metadata and source snapshots,
 * so repo sessions (which clone, fetch, and push real git) had nothing to talk
 * to. This server backs each mock repo with a bare repository under `root`
 * and answers `/git/<namespace>/<repo>.git/*` through `git http-backend`.
 * Repos are created empty on first use. Like Artifacts, every request needs
 * the repo token (Bearer, or a Basic password); the token is
 * not checked further, since only loopback callers can reach this server.
 */

const repoPathPattern =
	/^\/git\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+\.git)(\/.*)?$/

export function parseMockGitPath(pathname: string) {
	const match = repoPathPattern.exec(pathname)
	if (!match) return null
	const [, namespace, repo, rest] = match
	if (
		!namespace ||
		!repo ||
		namespace.startsWith('.') ||
		repo.startsWith('.')
	) {
		return null
	}
	return { namespace, repo, rest: rest ?? '' }
}

/** Artifacts accepts the repo token as a Bearer or as a Basic password. */
export function hasRepoToken(header: string | undefined) {
	if (header?.startsWith('Bearer ')) {
		return header.slice('Bearer '.length).trim().length > 0
	}
	if (!header?.startsWith('Basic ')) return false
	const decoded = Buffer.from(
		header.slice('Basic '.length),
		'base64',
	).toString()
	const separator = decoded.indexOf(':')
	return separator >= 0 && decoded.slice(separator + 1).length > 0
}

function ensureBareRepo(repoDir: string) {
	if (existsSync(path.join(repoDir, 'HEAD'))) return
	mkdirSync(repoDir, { recursive: true })
	execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main'], {
		cwd: repoDir,
	})
	execFileSync('git', ['config', 'http.receivepack', 'true'], { cwd: repoDir })
}

function writeCgiResponse(
	response: http.ServerResponse,
	child: ReturnType<typeof spawn>,
) {
	let buffered = Buffer.alloc(0)
	let headersSent = false
	child.stdout?.on('data', (chunk: Buffer) => {
		if (headersSent) {
			response.write(chunk)
			return
		}
		buffered = Buffer.concat([buffered, chunk])
		const end = buffered.indexOf('\r\n\r\n')
		if (end === -1) return
		let status = 200
		for (const line of buffered.subarray(0, end).toString().split('\r\n')) {
			const separator = line.indexOf(':')
			if (separator <= 0) continue
			const name = line.slice(0, separator).trim()
			const value = line.slice(separator + 1).trim()
			if (name.toLowerCase() === 'status') {
				status = Number.parseInt(value, 10) || 200
			} else {
				response.setHeader(name, value)
			}
		}
		response.writeHead(status)
		headersSent = true
		response.write(buffered.subarray(end + 4))
	})
	child.on('close', () => {
		if (!headersSent) {
			response.writeHead(500)
		}
		response.end()
	})
}

function createMockArtifactsGitServer(input: { root: string }) {
	return http.createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1')
		const target = parseMockGitPath(url.pathname)
		if (!target) {
			response.writeHead(404).end('Not Found')
			return
		}
		if (!hasRepoToken(request.headers.authorization)) {
			response
				.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock-artifacts"' })
				.end('Unauthorized')
			return
		}
		const repoDir = path.join(input.root, target.namespace, target.repo)
		try {
			ensureBareRepo(repoDir)
		} catch (error) {
			response.writeHead(500).end(String(error))
			return
		}
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			GIT_PROJECT_ROOT: input.root,
			GIT_HTTP_EXPORT_ALL: '1',
			PATH_INFO: `/${target.namespace}/${target.repo}${target.rest}`,
			REQUEST_METHOD: request.method ?? 'GET',
			QUERY_STRING: url.search.replace(/^\?/, ''),
			CONTENT_TYPE: request.headers['content-type'] ?? '',
			REMOTE_USER: 'x',
			REMOTE_ADDR: '127.0.0.1',
		}
		const contentLength = request.headers['content-length']
		if (contentLength) env.CONTENT_LENGTH = contentLength
		const encoding = request.headers['content-encoding']
		if (typeof encoding === 'string') env.HTTP_CONTENT_ENCODING = encoding
		const protocol = request.headers['git-protocol']
		if (typeof protocol === 'string') env.GIT_PROTOCOL = protocol
		const child = spawn('git', ['http-backend'], { env })
		request.pipe(child.stdin)
		child.stderr.on('data', () => {})
		writeCgiResponse(response, child)
	})
}

export async function startMockArtifactsGitServer(input: {
	root: string
	port?: number
}) {
	mkdirSync(input.root, { recursive: true })
	const server = createMockArtifactsGitServer({ root: input.root })
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(input.port ?? 0, '127.0.0.1', () => resolve())
	})
	const { port } = server.address() as AddressInfo
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve())
			}),
	}
}
