import {
	runIsolatedLocalExecutePackageGraphBuild,
	type IsolatedLocalExecutePackageGraphRequest,
} from '#worker/package-runtime/isolated-local-execute-package-graph.ts'
import { createMemoryKvNamespace } from './memory-kv.ts'
import {
	buildUnsignedLocalExecutePackageGraph,
	signLocalExecutePackageGraph,
} from '#worker/package-runtime/local-execute-package-graph.ts'

/** Build and sign a package graph in-process, as the isolated builder and API do. */
export async function buildLocalExecutePackageGraph(input: {
	env: Env
	baseUrl: string
	userId: string
	actorUserId: string | null
	code: string
}) {
	const graph = await buildUnsignedLocalExecutePackageGraph(input)
	return await signLocalExecutePackageGraph({
		env: input.env,
		graph,
		subject: { org: input.userId, actor: input.actorUserId },
	})
}

/**
 * Give an Open API test env the package graph builder's bindings: an
 * in-memory `BUNDLE_ARTIFACTS_KV` and a `REPO_SESSION` whose every instance
 * runs the isolated build in-process behind a structured-clone boundary,
 * like Durable Object RPC.
 */
export function addInProcessPackageGraphIsolates(env: Env) {
	const isolateNames: Array<string> = []
	Object.assign(env, {
		BUNDLE_ARTIFACTS_KV: createMemoryKvNamespace().kv,
		REPO_SESSION: {
			idFromName(name: string) {
				isolateNames.push(name)
				return name
			},
			get() {
				return {
					async buildIsolatedLocalExecutePackageGraph(
						input: IsolatedLocalExecutePackageGraphRequest,
					) {
						return await runIsolatedLocalExecutePackageGraphBuild(
							env,
							structuredClone(input),
						)
					},
				}
			},
		},
	})
	return { isolateNames }
}
