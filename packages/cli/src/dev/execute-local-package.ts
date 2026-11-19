import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadPackageManifest } from '../package-manifest.js'
import { resolveExecuteInvokeCode } from '../invoke-passthrough.js'
import { runRemoteExecuteWithToken } from '../remote-execute.js'
import type { CredentialCallMapInput } from '../credential-call-map.js'
import { resolveLocalKodySession } from './local-kody-session.js'

export async function findLocalPackageExport(input: {
	cwd?: string
	modulePath?: string
}) {
	let manifest
	try {
		manifest = await loadPackageManifest(input.cwd)
	} catch {
		return null
	}
	if (!input.modulePath) return null
	const modulePath = await realpath(
		resolve(input.cwd ?? process.cwd(), input.modulePath),
	)
	for (const [key, path] of Object.entries(manifest.exports)) {
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
