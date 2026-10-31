/**
 * Package credential needs (ADR 0068, `kody.credentials`). A need is a keyed
 * request for a credential of a provider (and optionally a kind); callers pick
 * which of their credentials fills it, or it auto-resolves to the one
 * candidate. Omitting `kind` matches any fetch-capable credential for the
 * provider (secret/Key, oauth, login).
 *
 * A package's needs closure is its own needs plus those of the packages it
 * statically imports, pinned at its publish (dependencies are snapshotted
 * then too, per ADR 0001) and stored with its published manifest snapshot.
 * Declaring needs never changes how Key placeholders fill.
 */
import { z } from 'zod'
import {
	isFetchCapableCredentialKind,
	packageCredentialSlotKindValues,
	secretProviderSlotKind,
	type AuthoredPackageJson,
	type PackageCredentialKind,
	type PackageCredentialSlotKind,
} from '#worker/package-registry/types.ts'

export const credentialNeedSchema = z.object({
	key: z.string(),
	kind: z.enum(packageCredentialSlotKindValues).optional(),
	provider: z.string(),
	/** Kind `secret-provider` only: the provider package name. */
	package: z.string().optional(),
	description: z.string(),
	multiple: z.boolean(),
	/**
	 * Deprecated legacy alias for `supplier: 'publisher'`, set only by the
	 * package that declares the need.
	 */
	ownerCredentialForVisitors: z.literal(true).optional(),
	supplier: z.enum(['publisher', 'executor']).optional(),
	required: z.boolean().optional(),
	/** The dependency that declared an inherited need. */
	from: z.string().optional(),
})

export type CredentialNeed = z.infer<typeof credentialNeedSchema>

export const credentialNeedsClosureSchema = z.array(credentialNeedSchema)

/** A need a saved credential fills: every kind but `secret-provider`. */
export type SavedCredentialNeed = Omit<CredentialNeed, 'kind'> & {
	kind?: PackageCredentialKind
}

/** A need for a bound secret provider; `provider` is the provider id. */
export function isSecretProviderNeed(need: Pick<CredentialNeed, 'kind'>) {
	return need.kind === secretProviderSlotKind
}

/** A secret provider id as the gateway reads it (`normalizeProviderId`). */
export function normalizeSecretProviderNeedId(provider: string) {
	return provider.trim().toLowerCase()
}

/** The manifest shape that declares a provider package, for fix messages. */
export function secretProviderSlotExample(
	packageName = '@your-org/provider-package',
) {
	return `"vault": { "kind": "secret-provider", "package": "${packageName}", "description": "What this package reads from the vault." }`
}

/**
 * Needs that callers fill with a saved credential. Secret-provider needs are
 * filled by the org's provider binding and per-ref package grants, so they
 * stay out of call maps, mappings, candidates, and creation links.
 */
export function savedCredentialNeeds(
	needs: ReadonlyArray<CredentialNeed>,
): Array<SavedCredentialNeed> {
	return needs.filter(
		(need): need is SavedCredentialNeed => !isSecretProviderNeed(need),
	)
}

const providerSlugPattern = /^[a-z0-9-]+$/

type ManifestCredentials = AuthoredPackageJson['kody']['credentials']

/** The package's own declared needs, with `provider` defaulted to the key. */
export function ownCredentialNeeds(
	credentials: ManifestCredentials,
	options: { supplierSemanticsEnabled?: boolean } = {},
): Array<CredentialNeed> {
	return Object.entries(credentials ?? {})
		.map(([key, slot]) => {
			const supplier = slot.ownerCredentialForVisitors
				? 'publisher'
				: slot.supplier
			return {
				key,
				...(slot.kind ? { kind: slot.kind } : {}),
				provider: slot.provider ?? key,
				...(slot.package ? { package: slot.package } : {}),
				description: slot.description,
				multiple: slot.multiple === true,
				...(slot.ownerCredentialForVisitors
					? { ownerCredentialForVisitors: true as const }
					: {}),
				...(options.supplierSemanticsEnabled && supplier ? { supplier } : {}),
				...(options.supplierSemanticsEnabled && supplier === 'executor'
					? { required: slot.required ?? true }
					: {}),
			}
		})
		.sort((left, right) => left.key.localeCompare(right.key))
}

function describeNeedKind(kind: PackageCredentialSlotKind | undefined): string {
	return kind ?? 'any fetch-capable kind'
}

/**
 * Two needs for the same key agree when providers match and kinds are
 * compatible: equal kinds, both omitted, or one omitted and the other a
 * fetch-capable kind (the declared kind is kept).
 */
export function credentialNeedKindsCompatible(
	left: PackageCredentialSlotKind | undefined,
	right: PackageCredentialSlotKind | undefined,
): boolean {
	if (left === right) return true
	if (left == null) return right != null && isFetchCapableCredentialKind(right)
	if (right == null) return isFetchCapableCredentialKind(left)
	return false
}

export function mergeCredentialNeedKinds(
	left: PackageCredentialSlotKind | undefined,
	right: PackageCredentialSlotKind | undefined,
): PackageCredentialSlotKind | undefined {
	return left ?? right
}

/**
 * Publish notes for keys that are not provider slugs. They never fail a
 * publish: the need still works when a caller picks a credential for it.
 */
export function credentialNeedKeyNotes(
	credentials: ManifestCredentials,
): Array<string> {
	return Object.entries(credentials ?? {}).flatMap(([key, slot]) => {
		if (providerSlugPattern.test(key) || isSecretProviderNeed(slot)) return []
		const provider = slot.provider ?? key
		return [
			providerSlugPattern.test(provider)
				? `kody.credentials.${key}: keys usually name their provider; "${provider}" would read more clearly as the key.`
				: `kody.credentials.${key}: "${provider}" is not a provider slug (lowercase letters, numbers, hyphens), so no credential auto-resolves for it; callers pick one for this need instead.`,
		]
	})
}

export type DependencyCredentialNeeds = {
	packageName: string
	needs: ReadonlyArray<CredentialNeed>
}

/**
 * Own needs first, then each dependency's closure. A key declared twice must
 * agree on provider and compatible kinds; any disagreement is returned as a
 * conflict. When one side omits `kind` and the other declares a fetch-capable
 * kind, the declared kind is kept. `ownerCredentialForVisitors` follows the
 * first declaration, like `description`: a dependency never turns it on for
 * a key the package itself declares.
 */
export function mergeCredentialNeeds(input: {
	own: ReadonlyArray<CredentialNeed>
	dependencies: ReadonlyArray<DependencyCredentialNeeds>
	supplierSemanticsEnabled?: boolean
}): { needs: Array<CredentialNeed>; conflicts: Array<string> } {
	const byKey = new Map<string, CredentialNeed>()
	const conflicts: Array<string> = []
	const describe = (need: CredentialNeed) =>
		`${describeNeedKind(need.kind)} from provider "${need.provider}" (${need.from ? `declared by ${need.from}` : 'declared by this package'})`
	const describeSupplier = (need: CredentialNeed) =>
		need.ownerCredentialForVisitors ? 'publisher' : (need.supplier ?? 'legacy')
	const add = (need: CredentialNeed) => {
		const existing = byKey.get(need.key)
		if (!existing) {
			byKey.set(need.key, need)
			return
		}
		if (
			existing.provider !== need.provider ||
			existing.package !== need.package ||
			!credentialNeedKindsCompatible(existing.kind, need.kind)
		) {
			conflicts.push(
				`kody.credentials.${need.key}: ${describe(existing)} conflicts with ${describe(need)}. Give one of them a different key.`,
			)
			return
		}
		let supplier = describeSupplier(existing)
		let required = existing.required
		if (input.supplierSemanticsEnabled) {
			const incomingSupplier = describeSupplier(need)
			if (supplier !== incomingSupplier) {
				const importerTightensToPublisher =
					!existing.from &&
					supplier === 'publisher' &&
					incomingSupplier !== 'publisher'
				if (!importerTightensToPublisher) {
					conflicts.push(
						`kody.credentials.${need.key}: supplier "${supplier}" conflicts with supplier "${incomingSupplier}" from dependency "${need.from ?? 'another dependency'}".`,
					)
					return
				}
				supplier = 'publisher'
			}
			if (supplier === 'executor') {
				const existingRequired = existing.required ?? true
				const incomingRequired = need.required ?? true
				if (
					existingRequired !== incomingRequired &&
					(!existing.from || !need.from)
				) {
					const ownNeed = existing.from ? need : existing
					const dependency = existing.from ? existing : need
					if (ownNeed.required === false && dependency.required !== false) {
						conflicts.push(
							`kody.credentials.${need.key}: optional cannot loosen required executor need from dependency "${dependency.from ?? 'another dependency'}".`,
						)
						return
					}
				} else if (
					existingRequired !== incomingRequired &&
					existing.from &&
					need.from
				) {
					conflicts.push(
						`kody.credentials.${need.key}: required status conflicts with dependency "${need.from}".`,
					)
					return
				}
				required = existingRequired || incomingRequired
			}
		}
		const kind = mergeCredentialNeedKinds(existing.kind, need.kind)
		const multiple = need.multiple || existing.multiple
		byKey.set(need.key, {
			key: existing.key,
			provider: existing.provider,
			...(existing.package ? { package: existing.package } : {}),
			description: existing.description,
			multiple,
			...(kind ? { kind } : {}),
			...(existing.ownerCredentialForVisitors
				? { ownerCredentialForVisitors: true as const }
				: {}),
			...(input.supplierSemanticsEnabled && supplier !== 'legacy'
				? { supplier: supplier as 'publisher' | 'executor' }
				: {}),
			...(input.supplierSemanticsEnabled && supplier === 'executor'
				? { required: required ?? true }
				: {}),
			...(existing.from ? { from: existing.from } : {}),
		})
	}
	for (const need of input.own) add(need)
	for (const dependency of input.dependencies) {
		for (const need of dependency.needs) {
			add({ ...need, from: need.from ?? dependency.packageName })
		}
	}
	return {
		needs: [...byKey.values()].sort((left, right) =>
			left.key.localeCompare(right.key),
		),
		conflicts,
	}
}

/** Parses a stored closure; anything unreadable counts as not stored. */
export function readStoredCredentialNeeds(
	value: unknown,
	options: { supplierSemanticsEnabled?: boolean } = {},
): Array<CredentialNeed> | null {
	const parsed = credentialNeedsClosureSchema.safeParse(value)
	if (!parsed.success) return null
	if (!options.supplierSemanticsEnabled) {
		return parsed.data.map(
			({ supplier: _supplier, required: _required, ...need }) => need,
		)
	}
	return parsed.data.map((need) => {
		const supplier = need.ownerCredentialForVisitors
			? 'publisher'
			: need.supplier
		return {
			...need,
			...(supplier ? { supplier } : {}),
			...(supplier === 'executor' ? { required: need.required ?? true } : {}),
		}
	})
}
