/**
 * Which of a run's entry packages declare a machine capability in
 * `kody.machine`. Only a package's own published manifest counts: a
 * declaration does not pass through imports.
 */
import { getSavedPackageByIdInAnyOrg } from '#worker/package-registry/repo.ts'
import {
	packageMachineNeedsFor,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'
import { toServingSourceView } from '#worker/repo/serving-commit.ts'
import type { machineDefinedCapabilityKinds } from './machine-capabilities.ts'

type DeclaredKind = (typeof machineDefinedCapabilityKinds)[number]

export type UndeclaredPackage = { id: string; name: string }

/** Entry packages whose published `kody.machine` has no `name` of `kind`. */
export async function packagesNotDeclaring(input: {
	env: Env
	packageIds: ReadonlyArray<string>
	kind: DeclaredKind
	name: string
}): Promise<Array<UndeclaredPackage>> {
	const checked = await Promise.all(
		input.packageIds.map(async (id) => {
			const saved = await getSavedPackageByIdInAnyOrg(input.env.APP_DB, id)
			if (!saved) return { id, name: id }
			const declared = await servingMachineNeeds(input.env, saved).catch(
				() => undefined,
			)
			return packageMachineNeedsFor(declared, input.name).some(
				(need) => need.kind === input.kind,
			)
				? null
				: { id, name: saved.name }
		}),
	)
	return checked.filter((entry) => entry !== null)
}

/** `kody.machine` of the commit runs are served, not a publish still building. */
async function servingMachineNeeds(env: Env, saved: SavedPackageRecord) {
	const source = await getEntitySourceById(env.APP_DB, saved.sourceId)
	if (!source) return undefined
	const published = await loadPublishedEntityManifest({
		env,
		userId: saved.userId,
		sourceId: saved.sourceId,
		source: toServingSourceView(source),
	})
	return published.manifest.kody.machine
}

const kindWords = {
	command: 'command',
	lan: 'local network destination',
	fs: 'host folder',
} as const satisfies Record<DeclaredKind, string>

/** The fix an author can paste, named in `machine_need_undeclared`. */
export function undeclaredNeedMessage(input: {
	packages: ReadonlyArray<UndeclaredPackage>
	kind: DeclaredKind
	name: string
	contextName: string
}) {
	const names = input.packages.map((entry) => entry.name).join(', ')
	const example = JSON.stringify({
		kody: {
			machine: {
				[input.name]: {
					kind: input.kind,
					...(input.kind === 'fs' ? { mode: 'rw' } : {}),
					description: 'Why the package needs it',
				},
			},
		},
	})
	return `${names} ${input.packages.length === 1 ? 'uses' : 'use'} ${kindWords[input.kind]} "${input.name}" on ${input.contextName} without declaring it. Add it to the package's package.json and publish again (use a list when the name already has an entry of another kind): ${example}`
}
