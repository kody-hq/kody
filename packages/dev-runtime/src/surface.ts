import type { alwaysRemoteBindingKeys } from './local-config.ts'

const packageAppsDoc = 'docs/guides/package-apps.md'

/**
 * Boundaries `kody dev` replaces with a local mock. Everything else in the
 * package runtime runs the hosted code on the local workers.
 */
export const kodyDevBoundaryMocks = {
	ai: `${packageAppsDoc}#boundary-mocks-in-kody-dev`,
	artifacts: `${packageAppsDoc}#boundary-mocks-in-kody-dev`,
	vectorize: `${packageAppsDoc}#boundary-mocks-in-kody-dev`,
	images: `${packageAppsDoc}#boundary-mocks-in-kody-dev`,
	email: `${packageAppsDoc}#email-outbox`,
	packageSecrets: `${packageAppsDoc}#mock-package-secrets`,
	outboundFetch: `${packageAppsDoc}#boundary-mocks-in-kody-dev`,
} as const satisfies Record<
	(typeof alwaysRemoteBindingKeys)[number] | string,
	string
>

/** Package app bridge methods that hit a boundary mock under `kody dev`. */
export const kodyDevBoundaryBridgeMethods = {
	packageSecretGet: 'packageSecrets',
	packageSecretHas: 'packageSecrets',
	authenticatedFetch: 'outboundFetch',
	packageBoundFetch: 'outboundFetch',
} as const satisfies Record<string, keyof typeof kodyDevBoundaryMocks>

export type KodyDevAllowlistEntry = {
	gap: number
	title: string
	docs: string
	/** `kody:runtime` exports the working-tree bridge cannot serve here. */
	exports: ReadonlyArray<string>
}

/**
 * Known gaps CI accepts. Each links its docs entry. Only gap 8 remains: the
 * working-tree bridge on `--target prod` keeps its trust rule.
 */
export const kodyDevAllowlist: ReadonlyArray<KodyDevAllowlistEntry> = [
	{
		gap: 8,
		title: 'Working-tree storage on --target prod',
		docs: `${packageAppsDoc}#gap-8-working-tree-storage-on---target-prod`,
		exports: [
			'packageStorage',
			'packageSecrets',
			'email',
			'events',
			'packages',
		],
	},
]
