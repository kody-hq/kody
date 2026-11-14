import {
	runIsolatedModuleArtifactRebuild,
	type IsolatedModuleArtifactRebuildRequest,
} from '#worker/package-invocations/module-artifacts.ts'
import {
	runIsolatedExecuteBundleBuild,
	type IsolatedExecuteBundleRequest,
} from '#worker/package-runtime/isolated-execute-bundle.ts'

/**
 * Give a test env a `REPO_SESSION` whose every instance runs hosted execute's
 * isolated bundle build in-process behind a structured-clone boundary, like
 * Durable Object RPC. Pass `isolate` to stand in for the build isolate, for
 * example to make it reset.
 */
export function addInProcessExecuteBundleIsolates(
	env: Env,
	isolate?: (input: IsolatedExecuteBundleRequest) => Promise<unknown>,
	rebuildIsolate?: (
		input: IsolatedModuleArtifactRebuildRequest,
	) => Promise<unknown>,
) {
	const isolateNames: Array<string> = []
	Object.assign(env, {
		REPO_SESSION: {
			idFromName(name: string) {
				isolateNames.push(name)
				return name
			},
			get() {
				return {
					async rebuildIsolatedModuleArtifact(
						input: IsolatedModuleArtifactRebuildRequest,
					) {
						const cloned = structuredClone(input)
						return rebuildIsolate
							? await rebuildIsolate(cloned)
							: await runIsolatedModuleArtifactRebuild(env, cloned)
					},
					async buildIsolatedExecuteBundle(
						input: IsolatedExecuteBundleRequest,
					) {
						const cloned = structuredClone(input)
						return isolate
							? await isolate(cloned)
							: await runIsolatedExecuteBundleBuild(env, cloned)
					},
				}
			},
		},
	})
	return { isolateNames }
}
