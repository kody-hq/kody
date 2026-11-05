import type { RepositoryOwnerOption } from '#universal/repository-create.ts'

/** The open Fork into chooser: forkable orgs and the preselected slug. */
export type ForkTargetChoice = {
	owners: Array<RepositoryOwnerOption>
	selected: string
}

/** The `org` a fork request sends for a picked slug; personal sends null. */
export function forkOrgForSlug(
	owners: Array<RepositoryOwnerOption>,
	slug: string,
): string | null {
	const owner = owners.find((option) => option.slug === slug)
	return !owner || owner.personal ? null : owner.slug
}

/**
 * Pressing Fork: with one forkable org, fork straight into it; with more,
 * open the chooser with the `?org=` pick (personal by default) preselected.
 * `currentOrg` is that pick, null for personal.
 */
export async function pressFork(input: {
	loadOwners: () => Promise<Array<RepositoryOwnerOption>>
	currentOrg: string | null
	fork: (org: string | null) => Promise<void> | void
	choose: (choice: ForkTargetChoice) => void
}) {
	const owners = await input.loadOwners()
	const [only] = owners
	if (owners.length < 2) {
		await input.fork(
			only ? forkOrgForSlug(owners, only.slug) : input.currentOrg,
		)
		return
	}
	const current = input.currentOrg?.toLowerCase()
	const picked = current
		? owners.find(
				(owner) => !owner.personal && owner.slug.toLowerCase() === current,
			)
		: undefined
	const personal = owners.find((owner) => owner.personal)
	input.choose({
		owners,
		selected: (picked ?? personal ?? only)!.slug,
	})
}
