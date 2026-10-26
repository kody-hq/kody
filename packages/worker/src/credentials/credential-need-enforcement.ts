/**
 * Credential-need enforcement (issue #3822, ADR 0068 amendment 2026-10-15;
 * issue #3836 phase 3).
 *
 * A package that stored a credential stamp may use only the credentials its
 * `kody.credentials` closure declares, including when its author runs it. The
 * global `credential-need-enforcement` flag is not that switch.
 *
 * A package with no stamp keeps the legacy path: the flag (off by default)
 * limits a run by anyone but its author, and implicit user-secret read stays.
 * Ad hoc code (no package id) is never limited. Placement stays fill-anywhere;
 * this is about declaration only.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { credentialNeedEnforcementFlagKey } from '#universal/feature-flags/registry.ts'
import {
	isFeatureGloballyEnabled,
	isMissingFeatureFlagsTable,
} from '#worker/feature-flags/service.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'
import { type CredentialNeed } from './credential-needs.ts'
import { packageCarriesCredentialStamp } from './credential-stamp-presence.ts'

export const credentialNeedUndeclaredCode = 'credential_need_undeclared'

/** One credential use to check, in the words of the code that made it. */
export type CredentialNeedReference =
	| { use: 'secret'; name: string; scope: SecretScope | null }
	| { use: 'integration'; name: string }
	| { use: 'provider'; provider: string }
	| { use: 'key'; key: string }

export class CredentialNeedUndeclaredError extends McpCallerError {
	readonly code = credentialNeedUndeclaredCode
	/** The kody.credentials key to declare. */
	readonly key: string
	/** The message without its leading code. */
	readonly detail: string
	constructor(input: { key: string; message: string }) {
		// The code leads the message so a fetch rejection, which carries only
		// the message, still says which error it is.
		super(`[${credentialNeedUndeclaredCode}] ${input.message}`)
		this.name = 'CredentialNeedUndeclaredError'
		this.key = input.key
		this.detail = input.message
	}
}

type Declarations = ReadonlyArray<CredentialNeed>

type EnforcedPackage =
	| { kind: 'exempt' }
	| {
			kind: 'enforced'
			/** Stamp enforcement applies to the author too. */
			stamped: boolean
			saved: SavedPackageRecord | null
			stored: () => Promise<Declarations>
			fresh: () => Promise<Declarations>
	  }

const enforcementByRequest = new WeakMap<
	RequestContext,
	Map<string, Promise<EnforcedPackage>>
>()
const flagByRequest = new WeakMap<RequestContext, Promise<boolean>>()

function memo<T>(load: () => Promise<T>) {
	let promise: Promise<T> | null = null
	return () => (promise ??= load())
}

/** Package and session buckets are bound to the package by construction. */
function isPackageBoundScope(scope: SecretScope | null) {
	return scope === 'package' || scope === 'session'
}

function referenceKey(reference: CredentialNeedReference) {
	switch (reference.use) {
		case 'secret':
		case 'integration':
			return reference.name
		case 'provider':
			return reference.provider
		case 'key':
			return reference.key
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled reference: ${String(exhaustive)}`)
		}
	}
}

/**
 * Declared slot kinds that may fill a use. Null means any kind. An omitted
 * kind fills any use.
 */
function fillingKinds(
	reference: CredentialNeedReference,
): ReadonlyArray<string> | null {
	switch (reference.use) {
		case 'secret':
			// secretJwtSign and {{secret:NAME}} read a secret. Seal leaves an
			// existing kind "signing" slot unchanged (credential(key).sign()
			// uses that kind), so a declared signing key still fills them.
			return ['secret', 'signing']
		case 'provider':
			return ['secret']
		case 'integration':
			return ['oauth']
		case 'key':
			return null
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled reference: ${String(exhaustive)}`)
		}
	}
}

/** The declared need that fills `reference`, or null. */
export function findDeclaredNeed(
	reference: CredentialNeedReference,
	declarations: Declarations,
) {
	const key = referenceKey(reference)
	const kinds = fillingKinds(reference)
	return (
		declarations.find(
			(need) =>
				need.key === key &&
				(kinds === null || need.kind == null || kinds.includes(need.kind)),
		) ?? null
	)
}

export function isCredentialReferenceDeclared(
	reference: CredentialNeedReference,
	declarations: Declarations,
) {
	if (reference.use === 'secret' && isPackageBoundScope(reference.scope)) {
		return true
	}
	return findDeclaredNeed(reference, declarations) !== null
}

function describeUse(reference: CredentialNeedReference) {
	switch (reference.use) {
		case 'secret':
			return `the secret "${reference.name}"`
		case 'integration':
			return `the integration "${reference.name}"`
		case 'provider':
			return `the vault provider "${reference.provider}"`
		case 'key':
			return `the credential key "${reference.key}"`
		default: {
			const exhaustive: never = reference
			throw new Error(`Unhandled reference: ${String(exhaustive)}`)
		}
	}
}

function undeclaredError(
	reference: CredentialNeedReference,
	saved: SavedPackageRecord | null,
	stamped: boolean,
) {
	const key = referenceKey(reference)
	const subject = saved ? `Package ${saved.name}` : 'This package'
	const rule = stamped
		? 'A package with a credential stamp may use only the credentials it declares.'
		: 'A package run by anyone but its author may use only the credentials it declares.'
	return new CredentialNeedUndeclaredError({
		key,
		message: `${subject} uses ${describeUse(reference)} without declaring it. ${rule} Add "${key}" to kody.credentials in its package.json (with a description) and publish again.`,
	})
}

async function isAuthorsOwnPackage(input: {
	env: Env
	request: RequestContext | null
	saved: SavedPackageRecord
}) {
	const person = input.request?.actor
	if (!person || input.saved.isInternetVisible) return false
	const personalOrgId = await loadPersonalOrgIdForPerson(
		input.env.APP_DB,
		person.userId,
		input.request,
	)
	if (input.saved.userId !== personalOrgId) return false
	const unadoptedFork = await input.env.APP_DB.prepare(
		`SELECT 1 AS fork FROM community_forks
		WHERE forked_package_id = ? AND adopted_at IS NULL
		LIMIT 1`,
	)
		.bind(input.saved.id)
		.first<{ fork: number }>()
	return !unadoptedFork
}

async function loadEnforcedPackage(input: {
	env: Env
	request: RequestContext | null
	orgId: string
	packageId: string
}): Promise<EnforcedPackage> {
	// Needs are a fact about the package. An imported dependency lives in
	// another org than the run that is using it.
	const saved = await getSavedPackageByIdInAnyOrg(
		input.env.APP_DB,
		input.packageId,
	)
	const empty = async (): Promise<Declarations> => []
	const stamped = await packageCarriesCredentialStamp(input)
	if (!saved) {
		return {
			kind: 'enforced',
			stamped,
			saved: null,
			stored: empty,
			fresh: empty,
		}
	}
	// Author exemption is the legacy flag path. A stamp replaces it.
	if (!stamped && (await isAuthorsOwnPackage({ ...input, saved }))) {
		return { kind: 'exempt' }
	}
	const declarations = (fresh: boolean) =>
		memo(() =>
			loadPublishedCredentialNeeds({
				env: input.env,
				userId: saved.userId,
				sourceId: saved.sourceId,
				fresh,
				request: input.request,
			}),
		)
	return {
		kind: 'enforced',
		stamped,
		saved,
		stored: declarations(false),
		fresh: declarations(true),
	}
}

function enforcedPackageFor(input: {
	env: Env
	request: RequestContext | null
	orgId: string
	packageId: string
}) {
	if (!input.request) return loadEnforcedPackage(input)
	let byPackage = enforcementByRequest.get(input.request)
	if (!byPackage) {
		byPackage = new Map()
		enforcementByRequest.set(input.request, byPackage)
	}
	const cacheKey = `${input.orgId}\n${input.packageId}`
	let loaded = byPackage.get(cacheKey)
	if (!loaded) {
		loaded = loadEnforcedPackage(input)
		byPackage.set(cacheKey, loaded)
		loaded.catch(() => byPackage.delete(cacheKey))
	}
	return loaded
}

function isEnforcementOn(env: Env, request: RequestContext | null) {
	// Workers-unit D1 does not apply migrations, so a missing flag table is the
	// registry default (off).
	const load = () =>
		isFeatureGloballyEnabled(
			env.APP_DB,
			credentialNeedEnforcementFlagKey,
		).catch((error: unknown) => {
			if (isMissingFeatureFlagsTable(error)) return false
			throw error
		})
	if (!request) return load()
	let enabled = flagByRequest.get(request)
	if (!enabled) {
		enabled = load()
		flagByRequest.set(request, enabled)
		enabled.catch(() => flagByRequest.delete(request))
	}
	return enabled
}

/**
 * Whether this package is limited to its declared credentials. A stored
 * credential stamp always limits it. Otherwise the global flag does, and the
 * author's own package stays exempt. Ad hoc code never is.
 */
export async function isPackageCredentialUseLimited(input: {
	env: Env
	request: RequestContext | null
	orgId: string
	packageId: string | null
}) {
	if (!input.packageId) return false
	const stamped = await packageCarriesCredentialStamp({
		...input,
		packageId: input.packageId,
	})
	if (!stamped && !(await isEnforcementOn(input.env, input.request))) {
		return false
	}
	const enforced = await enforcedPackageFor({
		...input,
		packageId: input.packageId,
	})
	return enforced.kind === 'enforced'
}

/**
 * Throws {@link CredentialNeedUndeclaredError} for the first use the stamped
 * package does not declare, and returns the declared need that fills each
 * checked use, by key (empty when the package is not limited). A use the
 * stored closure misses is checked again against a closure recomputed from the
 * package's imports, so a dependency that declared a need after this package
 * published still counts. Imports resolve only within the package's org, and
 * a dependency gains a need only through its owner's approval pause.
 */
export async function assertCredentialUsesDeclared(input: {
	env: Env
	request: RequestContext | null
	orgId: string
	packageId: string | null
	references: ReadonlyArray<CredentialNeedReference>
}): Promise<ReadonlyMap<string, CredentialNeed>> {
	const declared = new Map<string, CredentialNeed>()
	if (!input.packageId || input.references.length === 0) return declared
	const stamped = await packageCarriesCredentialStamp({
		...input,
		packageId: input.packageId,
	})
	if (!stamped && !(await isEnforcementOn(input.env, input.request))) {
		return declared
	}
	const enforced = await enforcedPackageFor({
		env: input.env,
		request: input.request,
		orgId: input.orgId,
		packageId: input.packageId,
	})
	if (enforced.kind === 'exempt') return declared
	const record = (
		reference: CredentialNeedReference,
		declarations: Declarations,
	) => {
		const need = findDeclaredNeed(reference, declarations)
		if (need) declared.set(referenceKey(reference), need)
		return isCredentialReferenceDeclared(reference, declarations)
	}
	const stored = await enforced.stored()
	const missing = input.references.filter(
		(reference) => !record(reference, stored),
	)
	if (missing.length === 0) return declared
	const fresh = await enforced.fresh()
	const undeclared = missing.find((reference) => !record(reference, fresh))
	if (undeclared) {
		throw undeclaredError(undeclared, enforced.saved, enforced.stamped)
	}
	return declared
}
