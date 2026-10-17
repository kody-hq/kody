import { anonymousPersonalizedJsonCacheHeaders } from '#app/anonymous-html-cache.ts'
import {
	loadAccessiblePackageFileRaw,
	loadCommunityPackageFileRaw,
	type PackageFileRawResult,
} from '#app/package-files-data.ts'
import { resolvePackageFileRawViewer } from '#app/package-files-raw-viewer.ts'
import { type ApiError } from '#worker/open-api/errors.ts'
import { normalizePackageFilesPath } from '#universal/package-files.ts'

// Raw bytes share the app origin. `sandbox` keeps anything a browser does
// render (SVG opened directly, a PDF viewer) in an opaque origin with no
// script, and nosniff stops text/plain from being reinterpreted as HTML.
const rawCsp = "default-src 'none'; sandbox"

function rawNotFound() {
	return new Response('Not found', {
		status: 404,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': rawCsp,
		},
	})
}

function rawInvalidCredentials(error: ApiError) {
	return new Response(`${error.message}\n`, {
		status: error.status,
		headers: {
			...error.headers,
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': rawCsp,
		},
	})
}

function rawTooLarge() {
	return new Response('File too large to serve raw', {
		status: 413,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': rawCsp,
		},
	})
}

function rawFileResponse(input: {
	request: Request
	result: Extract<PackageFileRawResult, { kind: 'ok' }>
}) {
	const credentialed = input.request.headers.has('Authorization')
	const headers = new Headers(
		anonymousPersonalizedJsonCacheHeaders({
			personalized: credentialed,
			request: input.request,
			visibilityGated: true,
		}),
	)
	if (input.result.isPrivate || credentialed) {
		headers.set('Cache-Control', 'private, no-store')
	}
	headers.set('Content-Type', input.result.contentType)
	headers.set(
		'Content-Disposition',
		`${input.result.disposition}; filename="${input.result.filename}"`,
	)
	headers.set('Content-Length', String(input.result.bytes.byteLength))
	headers.set('X-Content-Type-Options', 'nosniff')
	headers.set('Content-Security-Policy', rawCsp)
	if (input.request.method === 'HEAD') {
		return new Response(null, { headers })
	}
	const body = new Uint8Array(input.result.bytes.byteLength)
	body.set(input.result.bytes)
	return new Response(body.buffer, { headers })
}

function respondRaw(input: { request: Request; result: PackageFileRawResult }) {
	switch (input.result.kind) {
		case 'ok':
			return rawFileResponse({
				request: input.request,
				result: input.result,
			})
		case 'too-large':
			return rawTooLarge()
		case 'not-found':
			return rawNotFound()
		default: {
			const exhaustive: never = input.result
			throw new Error(`Unknown package file raw result: ${exhaustive}`)
		}
	}
}

function readRawSelectedPath(relativePath: unknown) {
	const selectedPath = normalizePackageFilesPath(
		typeof relativePath === 'string' ? relativePath : '',
	)
	return selectedPath == null || selectedPath === '' ? null : selectedPath
}

export function createCommunityPackageRawHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: {
			username: string
			kodyId: string
			ref: string
			relativePath: string | undefined
		}
	}) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405 })
		}
		const selectedPath = readRawSelectedPath(params.relativePath)
		if (selectedPath == null) return rawNotFound()
		const viewer = await resolvePackageFileRawViewer({ env, request })
		if (viewer.kind === 'invalid') {
			return rawInvalidCredentials(viewer.error)
		}
		const result = await loadAccessiblePackageFileRaw({
			env,
			request,
			username: params.username,
			kodyId: params.kodyId,
			selectedPath,
			ref: params.ref,
			...(viewer.kind === 'token'
				? { viewer: viewer.user, viewerOrgId: viewer.orgId }
				: {}),
		})
		return respondRaw({ request, result })
	}
}

export function createCommunityDetailRawHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { listingId: string; relativePath: string | undefined }
	}) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405 })
		}
		const selectedPath = readRawSelectedPath(params.relativePath)
		if (selectedPath == null) return rawNotFound()
		const result = await loadCommunityPackageFileRaw({
			env,
			request,
			listingId: params.listingId,
			selectedPath,
		})
		return respondRaw({ request, result })
	}
}
