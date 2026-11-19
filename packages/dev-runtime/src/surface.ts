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

export type KodyDevUnsupportedEntry = {
	title: string
	docs: string
	/** `kody:runtime` exports the working-tree bridge cannot serve here. */
	exports: ReadonlyArray<string>
}

export type KodyDevAllowlistEntry = KodyDevUnsupportedEntry & { gap: number }

/**
 * Open gaps CI accepts. Each links its docs entry and comes off the list as
 * soon as the bridge serves it. There are no open gaps.
 */
export const kodyDevAllowlist: ReadonlyArray<KodyDevAllowlistEntry> = []

/**
 * Won't do: exports the working-tree bridge refuses on purpose. CI accepts
 * them as intentionally unsupported. Unpublished code has no published package
 * id, and publish is the trust boundary for hosted storage, secrets, email,
 * events, and packages.
 */
export const kodyDevWontDo: ReadonlyArray<KodyDevUnsupportedEntry> = [
	{
		title:
			"Won't do: storage, secrets, email, events and packages on --target prod",
		docs: `${packageAppsDoc}#wont-do-storage-secrets-email-events-and-packages-on---target-prod`,
		exports: [
			'packageStorage',
			'packageSecrets',
			'email',
			'events',
			'packages',
		],
	},
]
