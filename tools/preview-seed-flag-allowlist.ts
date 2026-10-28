import { type FeatureFlagKey } from '#universal/feature-flags/registry.ts'

/**
 * Flags the public preview seed user (`me@kentcdodds.com`) may have forced on.
 *
 * Preview credentials are published. A key belongs here only when turning it
 * on for that account on a PR preview is safe. Local `--enable-flag` still
 * accepts any registry key; `--remote` does not.
 */
export const previewSeedFlagAllowlist = [
	'connection-profiles',
	'demo-indicator',
	'execution-contexts',
	'package-credential-suppliers',
] as const satisfies ReadonlyArray<FeatureFlagKey>

export type PreviewSeedFlagKey = (typeof previewSeedFlagAllowlist)[number]

const previewSeedFlagAllowlistSet = new Set<string>(previewSeedFlagAllowlist)

export function isPreviewSeedFlagKey(key: string): key is PreviewSeedFlagKey {
	return previewSeedFlagAllowlistSet.has(key)
}

export function previewSeedFlagRejection(key: string) {
	return `--enable-flag ${JSON.stringify(key)} is not on the preview seed allowlist (${previewSeedFlagAllowlist.join(', ')}). Add the key to tools/preview-seed-flag-allowlist.ts only when it is safe to force on for the public preview seed user.`
}
