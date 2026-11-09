import {
	parseBasicAuthSecretPlaceholders,
	parseSecretPlaceholders,
} from './placeholders.ts'
import type { SecretScope } from './types.ts'

type SecretMountDefinition = {
	name: string
	scope?: SecretScope
}

export type PackageUserSecretRef = {
	name: string
	scope: 'user'
}

export function collectUserSecretRefsFromPackageSource(input: {
	secretMounts?: Record<string, SecretMountDefinition> | null
	files?: Record<string, string> | null
}): Array<PackageUserSecretRef> {
	const names = new Set<string>()
	for (const mount of Object.values(input.secretMounts ?? {})) {
		if (mount.scope === 'package' || mount.scope === 'session') continue
		const name = mount.name.trim()
		if (name) names.add(name)
	}
	for (const content of Object.values(input.files ?? {})) {
		for (const ref of parseSecretPlaceholders(content)) {
			if (ref.scope === 'package' || ref.scope === 'session') continue
			names.add(ref.name)
		}
		for (const basic of parseBasicAuthSecretPlaceholders(content)) {
			if (basic.scope === 'package' || basic.scope === 'session') continue
			names.add(basic.username.name)
			names.add(basic.password.name)
		}
	}
	return Array.from(names)
		.sort((left, right) => left.localeCompare(right))
		.map((name) => ({ name, scope: 'user' as const }))
}

export function toSecretMountsFromUserRefs(
	refs: ReadonlyArray<PackageUserSecretRef>,
): Record<string, SecretMountDefinition> {
	const mounts: Record<string, SecretMountDefinition> = {}
	for (const ref of refs) {
		mounts[ref.name] = { name: ref.name, scope: 'user' }
	}
	return mounts
}
