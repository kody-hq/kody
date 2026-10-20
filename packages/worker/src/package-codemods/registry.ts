import { ambientStorageToPackageStorageCodemod } from './codemods/0001-ambient-storage-to-package-storage.ts'
import { staticFirstInvocationCodemod } from './codemods/0002-static-first-invocation.ts'
import { heykodyDomainsToKodyCodesCodemod } from './codemods/0003-heykody-domains-to-kody-codes.ts'
import { kodyappsDevToKodyRunCodemod } from './codemods/0004-kodyapps-dev-to-kody-run.ts'
import { kodyDependenciesToWildcardMapCodemod } from './codemods/0005-kody-dependencies-to-wildcard-map.ts'
import { invokeObjectToSpecifierCodemod } from './codemods/0006-invoke-object-to-specifier.ts'
import { prefixPackagesInvokeSpecifiersCodemod } from './codemods/0007-prefix-packages-invoke-specifiers.ts'
import { packagesInvokeToStaticImportCodemod } from './codemods/0008-packages-invoke-to-static-import.ts'
import { snakeCaseKodyMembersCodemod } from './codemods/0009-snake-case-kody-members.ts'
import { detectLegacyCredentialPatternsCodemod } from './codemods/0010-detect-legacy-credential-patterns.ts'
import { ownerScopeFollowsRegistryCodemod } from './codemods/0011-owner-scope-follows-registry.ts'
import { explicitWebhookUrlSecretVerificationCodemod } from './codemods/0012-explicit-webhook-url-secret-verification.ts'
import { declareCredentialNeedsCodemod } from './codemods/0013-declare-credential-needs.ts'
import { sealCredentialStampsCodemod } from './codemods/0014-seal-credential-stamps.ts'
import { convertCredentialStampsCodemod } from './codemods/0015-convert-credential-stamps.ts'
import { shortPackageAppSubdomainPathCodemod } from './codemods/0016-short-package-app-subdomain-path.ts'
import { type PackageCodemod } from './types.ts'

const packageCodemods: Array<PackageCodemod> = [
	ambientStorageToPackageStorageCodemod,
	staticFirstInvocationCodemod,
	heykodyDomainsToKodyCodesCodemod,
	kodyappsDevToKodyRunCodemod,
	kodyDependenciesToWildcardMapCodemod,
	invokeObjectToSpecifierCodemod,
	prefixPackagesInvokeSpecifiersCodemod,
	packagesInvokeToStaticImportCodemod,
	snakeCaseKodyMembersCodemod,
	detectLegacyCredentialPatternsCodemod,
	ownerScopeFollowsRegistryCodemod,
	explicitWebhookUrlSecretVerificationCodemod,
	declareCredentialNeedsCodemod,
	sealCredentialStampsCodemod,
	convertCredentialStampsCodemod,
	shortPackageAppSubdomainPathCodemod,
]

const packageCodemodsById = new Map(
	packageCodemods.map((codemod) => [codemod.id, codemod]),
)

export function listPackageCodemods(): Array<{
	id: string
	description: string
}> {
	return packageCodemods.map((codemod) => ({
		id: codemod.id,
		description: codemod.description,
	}))
}

export function getPackageCodemodById(id: string): PackageCodemod | null {
	return packageCodemodsById.get(id) ?? null
}
