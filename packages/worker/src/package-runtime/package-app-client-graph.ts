import {
	getPackageAppClientEntryPath,
	getPackageAppEntryPath,
} from '#worker/package-registry/manifest.ts'
import type { AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { resolveWorkspaceSourceFilePath } from './module-graph-paths.ts'
import {
	collectReachableSourceFilePaths,
	readRootPackage,
} from './module-graph-workspace.ts'

/**
 * The Worker entry (`kody.app.entry`) and the browser entry
 * (`kody.app.client`) are separate module graphs: the Worker bundle rewrites
 * `kody:` imports into runtime proxies and runs in an isolate, the client
 * bundle targets the browser. A Worker graph that reaches the client entry
 * would drag browser-only code (and its import-map externals) into the
 * isolate, so publish rejects it. Shared helpers imported by both graphs are
 * fine; only the client entry itself is off limits to the Worker.
 */
export function validatePackageAppGraphSeparation(input: {
	manifest: AuthoredPackageJson
	sourceFiles: Record<string, string>
}): { ok: true; message: string } | { ok: false; message: string } {
	const appEntry = getPackageAppEntryPath(input.manifest)
	const clientEntry = getPackageAppClientEntryPath(input.manifest)
	if (!appEntry || !clientEntry) {
		return { ok: true, message: 'No kody.app.client graph to separate.' }
	}
	const resolvedClientEntry =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: clientEntry,
		}) ?? clientEntry
	const resolvedAppEntry =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: appEntry,
		}) ?? appEntry
	if (resolvedAppEntry === resolvedClientEntry) {
		return {
			ok: false,
			message: `package.json#kody.app.entry and kody.app.client both point at "${resolvedClientEntry}". The Worker fetch handler and the browser client are separate module graphs; give the client its own entry (for example ./src/client/index.ts).`,
		}
	}
	const workerGraph = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint: resolvedAppEntry,
		rootPackage: readRootPackage(input.sourceFiles),
	})
	if (workerGraph.has(resolvedClientEntry)) {
		return {
			ok: false,
			message: `The Worker entry "${resolvedAppEntry}" imports the browser client entry "${resolvedClientEntry}" (directly or through another module). Keep the two graphs separate: the Worker renders <script type="module" src="\${packageContext.clientModuleUrl}"> and the client talks to it over fetch or the realtime facet. Browser-only packages stay out of the Worker bundle this way.`,
		}
	}
	return {
		ok: true,
		message: `Worker entry "${resolvedAppEntry}" does not import the client entry "${resolvedClientEntry}".`,
	}
}
