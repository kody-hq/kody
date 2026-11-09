/**
 * Publish offload builder: the worker's own artifact builders (the same
 * `@cloudflare/worker-bundler` and its esbuild.wasm, the same the cloud rebuild uses),
 * bundled into the Kody CLI as `dist/publish-builder.js` so a CLI or
 * execution-context build produces the bytes a server rebuild would.
 *
 * There is no D1 or KV off the worker, and none is needed: other Kody
 * packages stay `.__kody_linked__/…` imports (6C) that Kody fills in from
 * the registry when it commits the upload.
 */
import { buildPublishedPackageArtifactTargetBundle } from '#worker/package-runtime/published-bundle-artifact-persist.ts'
import { collectPublishedPackageArtifactTargets } from '#worker/package-runtime/package-artifact-targets.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { runPackageTypecheckForSourceTree } from '#worker/repo/checks.ts'
import {
	hashWorkerLoaderModules,
	sha256Hex,
	workerLoaderModuleBytes,
} from './module-hashes.ts'
import { preparePublishBuildSourceTree } from './source-tree.ts'
import { publishBuilderVersion } from './types.ts'

export { publishBuilderVersion, sha256Hex, workerLoaderModuleBytes }

const offWorkerRegistryMessage =
	'The publish builder tried to read the Kody registry, which builds made outside Kody cloud never do. Update the Kody CLI and try again.'

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

function fromBase64(base64: string) {
	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

/**
 * Builds the commit's raw blobs (repo-root paths) the way the server
 * rebuilds its snapshot of them, and returns the file manifest the server
 * checks that snapshot against.
 */
export async function buildPublishTargets(input: {
	files: Array<{ path: string; base64: string }>
	sourceRoot?: string
	manifestPath?: string
	rootPackageId: string
	userId: string
	baseUrl: string
}) {
	const tree = await preparePublishBuildSourceTree({
		files: input.files.map((file) => ({
			path: file.path,
			bytes: fromBase64(file.base64),
		})),
		sourceRoot: input.sourceRoot ?? '/',
	})
	const manifestPath = input.manifestPath ?? 'package.json'
	const manifestSource = tree.sourceFiles[manifestPath]
	if (typeof manifestSource !== 'string') {
		throw new Error(`${manifestPath} is missing from the build tree.`)
	}
	const sourceFiles = tree.sourceFiles
	const manifest = parseAuthoredPackageJson({ content: manifestSource })
	const typecheck = await runPackageTypecheckForSourceTree({
		sourceFiles,
		manifest: manifest as Parameters<
			typeof runPackageTypecheckForSourceTree
		>[0]['manifest'],
	})
	if (!typecheck.ok) {
		throw new Error(`Typecheck failed:\n${typecheck.message}`)
	}
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
		sourceFiles,
		rootPackageId: input.rootPackageId,
		prepareCache: new Map(),
		linkKodyPackageImports: true,
	}
	const builders = {
		buildAppBundle: async ({ entryPoint }: { entryPoint: string }) =>
			await buildKodyAppBundle({ ...shared, entryPoint, cacheKey: null }),
		buildAppClientBundle: async ({ entryPoint }: { entryPoint: string }) =>
			await buildKodyAppClientBundle({
				sourceFiles,
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
		})
	}
	return { files: tree.manifest, targets: built }
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
				files: built.files,
				targets: built.targets.map((entry) => ({
					target: entry.target,
					mainModule: entry.mainModule,
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
