import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadPackageManifest } from '../package-manifest.js'
import { resolveExecuteInvokeCode } from '../invoke-passthrough.js'
import { runRemoteExecuteWithToken } from '../remote-execute.js'
import type { CredentialCallMapInput } from '../credential-call-map.js'
import { resolveLocalKodySession } from './local-kody-session.js'

export async function findLocalPackageExport(input: {
	cwd?: string
	modulePath?: string
	exportKey?: string
}) {
	let manifest
	try {
		manifest = await loadPackageManifest(input.cwd)
	} catch {
		return null
	}
	if (!input.modulePath) return null
	const raw = JSON.parse(await readFile(manifest.packageJsonPath, 'utf8'))
	const exports =
		typeof raw.exports === 'string' ? { '.': raw.exports } : (raw.exports ?? {})
	const modulePath = await realpath(
		resolve(input.cwd ?? process.cwd(), input.modulePath),
	)
	const exportKey = input.exportKey?.trim().replace(/^\.\//, '')
	for (const [key, target] of Object.entries(exports)) {
		const conditional = target as { import?: unknown; default?: unknown } | null
		const path =
			typeof target === 'string'
				? target
				: (conditional?.import ?? conditional?.default)
		if (typeof path !== 'string') continue
		if (exportKey !== undefined && key.replace(/^\.\//, '') === exportKey)
			return { manifest, key }
		const exportedPath = await realpath(resolve(manifest.root, path)).catch(
			() => null,
		)
		if (exportedPath === modulePath) return { manifest, key }
	}
	return null
}

export async function executeLocalPackageExport(input: {
	export: NonNullable<Awaited<ReturnType<typeof findLocalPackageExport>>>
	params?: unknown
	conversationId?: string
	credentials?: CredentialCallMapInput
	onStatus?: (message: string) => void
	passthroughHosts?: ReadonlyArray<string>
	allowPrivateNetwork?: boolean
}) {
	const session = await resolveLocalKodySession({
		manifest: input.export.manifest,
		onStatus: input.onStatus,
		passthroughHosts: input.passthroughHosts,
		allowPrivateNetwork: input.allowPrivateNetwork,
	})
	if (!session) {
		throw new Error('Local Kody is unavailable for package export execution.')
	}
	try {
		if (!session.api) {
			throw new Error(
				'Restart kody dev to register a private local Kody API session.',
			)
		}
		await session.sync()
		const suffix =
			input.export.key === '.'
				? ''
				: `/${input.export.key.replace(/^\.\//, '')}`
		const code = resolveExecuteInvokeCode(
			`kody:${input.export.manifest.name}${suffix}`,
		)
		return await runRemoteExecuteWithToken({
			code,
			params: input.params,
			conversationId: input.conversationId,
			credentials: input.credentials,
			apiUrl: session.api.origin,
			token: session.api.apiToken,
		})
	} finally {
		await session.close()
	}
}
