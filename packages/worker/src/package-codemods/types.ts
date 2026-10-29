export type PackageCodemodFinding = {
	path: string | null
	message: string
}

export type PackageCodemodTransformResult = {
	files: Record<string, string>
	changed: boolean
	changedPaths: Array<string>
	needsManual: Array<PackageCodemodFinding>
	/**
	 * Private per-package detail for the package owner (for example the exact
	 * names a fix adds). Stored on the run item, admin-only, never returned in
	 * step results or findings.
	 */
	ownerDetail?: Record<string, unknown>
}

/**
 * What the static scan of a package app's import closure (every `kody:@`
 * package it imports, followed from the imported export) found, plus the
 * capability names the runtime authority logs saw this app call undeclared.
 */
export type PackageAppCapabilityHostFacts = {
	closure: {
		/** Statically named kody calls reachable through imported packages. */
		names: Array<string>
		computedCalls: number
		mcpCalls: number
		/** Imports that could not be followed (missing, computed, unparsable). */
		unresolvedImports: number
	}
	observed: {
		/** `capability_not_declared` call names from fallbacks and rejections. */
		names: Array<string>
		/** Observed `credential.named` refusals; no capability entry covers them. */
		credentialNamedCalls: number
	}
	/** Builtin capability names; only these are ever added to a manifest. */
	platformCapabilityNames: Array<string>
}

export type PackageCodemodHostFactKind = 'package-app-capabilities'

/** Host facts about the package being repaired, never read from its files. */
export type PackageCodemodContext = {
	/** Registry name (`@org/kody-id`); its scope is the owning org. */
	packageName: string
	/**
	 * Where the package lives in its repo snapshot, as stored on its entity
	 * source. Omitted means the repo root (`package.json` at `/`).
	 */
	manifestPath?: string
	sourceRoot?: string
	/**
	 * Facts the engine computed with I/O before calling the codemod, only for
	 * codemods that request them through `hostFacts`.
	 */
	packageAppCapabilities?: PackageAppCapabilityHostFacts
}

/**
 * How apply/revert write when Artifacts default-branch HEAD has drifted from
 * `published_commit`.
 *
 * - `head-and-published` (default) — today's path: require HEAD == published,
 *   then `syncArtifactSourceSnapshot` (moves HEAD and published together).
 *   Drifted packages stay `skipped_drift`.
 * - `published-only` — on drift, commit the transformed published tree as a
 *   child of `published_commit`, push to the durable `kody-published` ref, and
 *   advance published via finalize — without moving default-branch HEAD.
 *   Non-drifted applies still use `syncArtifactSourceSnapshot`.
 */
export type PackageCodemodApplyMode = 'head-and-published' | 'published-only'

export type PackageCodemod = {
	id: string
	description: string
	/**
	 * Opt-in write lane for drifted packages. Omit for the historical
	 * head-and-published behavior (fleet default).
	 */
	applyMode?: PackageCodemodApplyMode
	/** Host facts the engine computes and passes in through the context. */
	hostFacts?: Array<PackageCodemodHostFactKind>
	detect(
		files: Record<string, string>,
		context: PackageCodemodContext,
	): Array<PackageCodemodFinding>
	transform(
		files: Record<string, string>,
		context: PackageCodemodContext,
	): PackageCodemodTransformResult
}
