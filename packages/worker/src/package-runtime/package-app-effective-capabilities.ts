import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { type BundleArtifactDependency } from './published-runtime-artifacts.ts'

/**
 * The Kody capabilities a package declares for its own modules (ADR 0089):
 * `kody.app.capabilities` for an app, `kody.capabilities` otherwise.
 */
export function declaredCapabilitiesOf(
	manifest: Pick<AuthoredPackageJson, 'kody'>,
): Array<string> {
	const app = manifest.kody.app
	return [
		...(app ? (app.capabilities ?? []) : (manifest.kody.capabilities ?? [])),
	]
}

/**
 * The capabilities a package app may call as its publisher: its own
 * declaration plus the declaration each bundled package in its static import
 * closure recorded at bundle time (ADR 0089). Bundles built before
 * dependencies recorded declarations contribute nothing extra.
 */
export function effectivePackageAppCapabilities(input: {
	manifest: Pick<AuthoredPackageJson, 'kody'>
	dependencies: ReadonlyArray<Pick<BundleArtifactDependency, 'capabilities'>>
}): Array<string> {
	const names = new Set(input.manifest.kody.app?.capabilities ?? [])
	for (const dependency of input.dependencies) {
		for (const name of dependency.capabilities ?? []) names.add(name)
	}
	return [...names].sort((left, right) => left.localeCompare(right))
}
