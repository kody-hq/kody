/**
 * Publish offload builder: the worker's own artifact builders (the same
 * `@cloudflare/worker-bundler` and its esbuild.wasm, the same the cloud rebuild uses),
 * bundled into the Kody CLI as `dist/publish-builder.js` so a CLI or
 * execution-context build produces the bytes a server rebuild would.
 *
 * There is no D1 or KV off the worker. A `kody:@…` import needs the
 * registry to inline that package, so off-worker builds refuse it for now
 * with a clear message; the server's 6A check still guards the upload.
 */
import { buildPublishedPackageArtifactTargetBundle } from '#worker/package-runtime/published-bundle-artifact-persist.ts'
import { collectPublishedPackageArtifactTargets } from '#worker/package-runtime/package-artifact-targets.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	hashWorkerLoaderModules,
	sha256Hex,
	workerLoaderModuleBytes,
} from './module-hashes.ts'
import { publishBuilderVersion } from './types.ts'

export { publishBuilderVersion, sha256Hex, workerLoaderModuleBytes }

export const offWorkerRegistryMessage =
	'This package imports another Kody package (`kody:@…`). Builds made outside Kody cloud cannot inline other packages yet; publish on Kody cloud (drop --build).'

function offWorkerEnv(): Env {
	const refuse = () => {
		throw new Error(offWorkerRegistryMessage)
	}
	return new Proxy({} as Env, {
		get: (_target, key) =>
			key === 'then'
				? undefined
				: new Proxy(refuse, { get: refuse, apply: refuse }),
	})
}

export async function buildPublishTargets(input: {
	sourceFiles: Record<string, string>
	rootPackageId: string
	userId: string
	baseUrl: string
}) {
	const manifestSource = input.sourceFiles['package.json']
	if (typeof manifestSource !== 'string') {
		throw new Error('package.json is missing from the build tree.')
	}
	const manifest = parseAuthoredPackageJson({ content: manifestSource })
	const targets = collectPublishedPackageArtifactTargets(
		manifest as Parameters<typeof collectPublishedPackageArtifactTargets>[0],
	)
	const {
		buildKodyAppBundle,
		buildKodyAppClientBundle,
		buildKodyModuleBundle,
		buildKodyImportableModuleBundle,
	} = await import('#worker/package-runtime/module-graph.ts')
	const shared = {
		env: offWorkerEnv(),
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles: input.sourceFiles,
		rootPackageId: input.rootPackageId,
		prepareCache: new Map(),
	}
	const builders = {
		buildAppBundle: async ({ entryPoint }: { entryPoint: string }) =>
			await buildKodyAppBundle({ ...shared, entryPoint, cacheKey: null }),
		buildAppClientBundle: async ({ entryPoint }: { entryPoint: string }) =>
			await buildKodyAppClientBundle({
				sourceFiles: input.sourceFiles,
				entryPoint,
			}),
		buildModuleBundle: async ({ entryPoint }: { entryPoint: string }) =>
			await buildKodyModuleBundle({ ...shared, entryPoint }),
		buildImportableModuleBundle: async ({
			entryPoint,
		}: {
			entryPoint: string
		}) => await buildKodyImportableModuleBundle({ ...shared, entryPoint }),
	}
	const built = []
	for (const target of targets) {
		const bundle = await buildPublishedPackageArtifactTargetBundle({
			...builders,
			target,
		})
		built.push({
			target,
			mainModule: bundle.mainModule,
			modules: bundle.modules,
			moduleHashes: await hashWorkerLoaderModules(bundle.modules),
			inlinedPackageIds: (bundle.dependencies ?? []).flatMap((dependency) =>
				dependency.packageId ? [dependency.packageId] : [],
			),
		})
	}
	return built
}

function toBase64(bytes: Uint8Array) {
	let binary = ''
	for (let index = 0; index < bytes.byteLength; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
	}
	return btoa(binary)
}

/**
 * The bundler only runs inside workerd, so the CLI serves this module from a
 * local workerd and POSTs the tree here. Each module comes back as the same
 * tagged bytes the server hashes (`workerLoaderModuleBytes`).
 */
export default {
	async fetch(request: Request) {
		try {
			const input = (await request.json()) as Parameters<
				typeof buildPublishTargets
			>[0]
			const built = await buildPublishTargets(input)
			return Response.json({
				ok: true,
				builderVersion: publishBuilderVersion,
				targets: built.map((entry) => ({
					target: entry.target,
					mainModule: entry.mainModule,
					inlinedPackageIds: entry.inlinedPackageIds,
					modules: Object.fromEntries(
						Object.entries(entry.modules).map(([path, module]) => [
							path,
							toBase64(workerLoaderModuleBytes(module)),
						]),
					),
				})),
			})
		} catch (error) {
			return Response.json({
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			})
		}
	},
}
