import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'

export type MemberCreation = NonNullable<
	OrgSettingsLoaderData['memberCreation']
>

const memberCreationKeys = [
	'packages',
	'credentials',
] as const satisfies ReadonlyArray<keyof MemberCreation>

export function sameMemberCreation(
	a: MemberCreation | null,
	b: MemberCreation | null,
) {
	if (!a || !b) return a === b
	return memberCreationKeys.every((key) => a[key] === b[key])
}

/**
 * Rebase the form draft onto a refetched saved value: fields the person has
 * not touched follow the new saved value (another Owner may have changed them),
 * and fields they edited keep their local value.
 */
export function rebaseMemberCreationDraft(
	draft: MemberCreation | null,
	previousSaved: MemberCreation | null,
	nextSaved: MemberCreation | null,
): MemberCreation | null {
	if (!nextSaved) return null
	if (!draft || !previousSaved) return nextSaved
	const next = { ...draft }
	for (const key of memberCreationKeys) {
		if (draft[key] === previousSaved[key]) next[key] = nextSaved[key]
	}
	return next
}
