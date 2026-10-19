import { normalizeSecretExpiresAt } from '@kody-internal/shared/secret-expires-at.ts'
import { type AccountSecretsLoaderData } from '#universal/loader-data.ts'
import { fillPlacementDraftFromView } from '#universal/credential-fill-placement.ts'
import { type EditorState } from './account-secrets-shared.ts'
import { normalizeAllowedHosts } from '#client/routes/secret-normalization.ts'
export function readConnectSecretSetView(input: {
	name: string
	saved: boolean
}) {
	const hasName = input.name.trim().length > 0
	return {
		hasName,
		saved: input.saved,
		showForm: hasName && !input.saved,
		showBackToSecrets: input.saved || !hasName,
	}
}
export function findMatchingSecretForSetup(
	secrets: AccountSecretsLoaderData['secrets'],
	state: Pick<EditorState, 'name' | 'scope' | 'packageId'>,
	options: {
		explicitPackageId?: string | null
	} = {},
) {
	const name = state.name.trim()
	if (!name) return null
	return (
		secrets.find((secret) => {
			if (secret.name !== name || secret.scope !== state.scope) return false
			if (state.scope !== 'package') return true
			// Require an explicit packageId from the setup URL. Do not match
			// against the editor fallback (first package option).
			const packageId = options.explicitPackageId?.trim()
			if (!packageId) return false
			return secret.packageId === packageId
		}) ?? null
	)
}
function queryHasNonEmptyList(params: URLSearchParams, keys: Array<string>) {
	return keys.some((key) =>
		params
			.getAll(key)
			.some((value) =>
				value.split(',').some((entry) => entry.trim().length > 0),
			),
	)
}
export function hydrateEditorStateForExistingSecret(
	state: EditorState,
	existing: NonNullable<ReturnType<typeof findMatchingSecretForSetup>>,
	href: string,
) {
	const params = new URL(href, 'http://localhost').searchParams
	const queryHasHosts = queryHasNonEmptyList(params, [
		'allowedHosts',
		'allowed-host',
	])
	const queryHasPackages = queryHasNonEmptyList(params, [
		'allowedPackages',
		'package_id',
		'package',
	])
	const queryHasDescription = Boolean(params.get('description')?.trim())
	// Only override expiry when the query parsed to a real value. An invalid
	// expiresAt must not clear an existing cutoff.
	const queryHasExpires = Boolean(state.expiresAt.trim())
	return {
		...state,
		currentId: existing.id,
		description: queryHasDescription ? state.description : existing.description,
		expiresAt: queryHasExpires ? state.expiresAt : (existing.expiresAt ?? ''),
		allowedHosts: queryHasHosts
			? state.allowedHosts
			: existing.allowedHosts.length > 0
				? existing.allowedHosts
				: [''],
		allowedPackages: queryHasPackages
			? state.allowedPackages
			: existing.allowedPackages,
		fillPlacement: fillPlacementDraftFromView(existing.placement),
	}
}
export function readExplicitPackageId(href: string) {
	return (
		new URL(href, 'http://localhost').searchParams.get('packageId')?.trim() ||
		null
	)
}
export function readInvalidExpiresAtQuery(href: string) {
	const raw = new URL(href, 'http://localhost').searchParams
		.get('expiresAt')
		?.trim()
	if (!raw) return null
	try {
		const normalized = normalizeSecretExpiresAt(raw)
		if (!normalized) {
			return 'This setup link has an invalid expiresAt value.'
		}
		return null
	} catch {
		return 'This setup link has an invalid expiresAt value.'
	}
}
export function resolvePackageIdForSecretSet(input: {
	scope: EditorState['scope']
	explicitPackageId: string | null
	packageOptions: Array<{
		id: string
	}>
}) {
	if (input.scope !== 'package') return { packageId: null as string | null }
	const packageId = input.explicitPackageId?.trim() || null
	if (!packageId) {
		return {
			packageId: null,
			error: 'Package-scoped setup links require a packageId.',
		}
	}
	if (!input.packageOptions.some((option) => option.id === packageId)) {
		return {
			packageId: null,
			error: 'This setup link names a package that is not available.',
		}
	}
	return { packageId }
}
export function resolveSavePolicyFromSetup(input: {
	href: string
	state: EditorState
	existing: AccountSecretsLoaderData['secrets'][number] | null
}) {
	const params = new URL(input.href, 'http://localhost').searchParams
	const queryHasHosts = queryHasNonEmptyList(params, [
		'allowedHosts',
		'allowed-host',
	])
	const queryHasPackages = queryHasNonEmptyList(params, [
		'allowedPackages',
		'package_id',
		'package',
	])
	const queryHasExpires = Boolean(input.state.expiresAt.trim())
	const allowedHosts = queryHasHosts
		? normalizeAllowedHosts(
				input.state.allowedHosts.filter((host) => host.trim()),
			)
		: (input.existing?.allowedHosts ??
			normalizeAllowedHosts(
				input.state.allowedHosts.filter((host) => host.trim()),
			))
	const allowedPackages =
		input.state.scope === 'user'
			? queryHasPackages
				? [...input.state.allowedPackages].sort((left, right) =>
						left.localeCompare(right),
					)
				: [
						...(input.existing?.allowedPackages ?? input.state.allowedPackages),
					].sort((left, right) => left.localeCompare(right))
			: []
	const expiresAt = queryHasExpires
		? input.state.expiresAt || null
		: (input.existing?.expiresAt ?? (input.state.expiresAt || null))
	return { allowedHosts, allowedPackages, expiresAt }
}
