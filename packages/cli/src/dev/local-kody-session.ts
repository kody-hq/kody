import type { KodyPackageManifest } from '../package-manifest.js'
import { StructuredCliError } from '../structured-error.js'
import { defaultDevPort } from './dev-port.js'
import { devCallPath, findRunningDevServer } from './dev-registry.js'

export const devCallUnavailable = Symbol('devCallUnavailable')

export async function resolveLocalKodySession(input: {
	manifest: KodyPackageManifest
	onStatus?: (message: string) => void
	passthroughHosts?: ReadonlyArray<string>
	allowPrivateNetwork?: boolean
}) {
	const running = await findRunningDevServer({
		root: input.manifest.root,
		target: 'mock',
	})
	if (running) {
		const { registration } = running
		const call = async (operation: string, args: Record<string, unknown>) => {
			const response = await fetch(
				new URL(`${registration.basePath}${devCallPath}`, registration.origin),
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ operation, input: args }),
				},
			)
			const body = (await response.json().catch(() => null)) as {
				result?: unknown
				error?: string
			} | null
			if (response.status === 404) return devCallUnavailable
			if (!response.ok) {
				throw new StructuredCliError({
					code: 'dev_local_call_failed',
					message:
						body?.error ??
						`Local Kody ${operation} failed (HTTP ${response.status}).`,
					target: 'mock',
				})
			}
			return body?.result
		}
		return {
			api: registration.localKody,
			call,
			sync: async () => {
				if ((await call('sync', {})) === devCallUnavailable) {
					throw new Error('Restart kody dev to enable local package execution.')
				}
			},
			ranOn: `running kody dev (pid ${registration.pid})`,
			close: async () => {},
		}
	}
	// The stub runtime only exists for the CLI's own offline test suite.
	if (process.env.KODY_DEV_STUB_RUNTIME === '1') return null
	input.onStatus?.(
		'Starting one-shot local Kody with the package dev-state store.',
	)
	const local = await import('./local-kody.js')
	const kody = await local.startLocalKody({
		manifest: input.manifest,
		packageAppPort: defaultDevPort(input.manifest.kodyId),
		passthroughHosts: input.passthroughHosts,
		allowPrivateNetwork: input.allowPrivateNetwork,
		onStatus: input.onStatus,
	})
	try {
		const upstream = local.createLocalKodyUpstream({
			kody,
			manifest: input.manifest,
		})
		await upstream.sync()
		return {
			api: { origin: kody.origin, apiToken: kody.apiToken },
			call: async (operation: string, args: Record<string, unknown>) => {
				const packageId = upstream.packageId()
				return await upstream.call(
					operation,
					packageId && operation !== 'jobList' && operation !== 'jobRunNow'
						? { ...args, package_id: packageId }
						: args,
				)
			},
			sync: upstream.sync,
			ranOn: 'a one-shot local Kody',
			close: kody.close,
		}
	} catch (error) {
		await kody.close()
		throw error
	}
}
