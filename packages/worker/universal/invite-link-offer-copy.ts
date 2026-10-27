import { type OrgInviteJoinLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { orgOverviewPath } from '#universal/org-pages.ts'

type JoinPageData = Extract<OrgInviteJoinLoaderData, { ok: true }>

export type InviteLinkOfferCopy = {
	title: string
	description: string
	/** Shown instead of `description` when the viewer already has it all. */
	satisfied: string
	subject: string
	subjectDetail: string
	/** What else accepting changes, when that is not obvious from the title. */
	notice: string | null
	acceptLabel: string
	openHref: string
	openLabel: string
}

/** The words on the `/join/:token` accept page for each kind of link. */
export function inviteLinkOfferCopy(data: JoinPageData): InviteLinkOfferCopy {
	const name = data.org.displayName?.trim() || data.org.slug
	const invitedYou = data.invitedBy
		? `${data.invitedBy} invited you`
		: 'You are invited'
	const offer = data.offer
	switch (offer.kind) {
		case 'membership':
			return {
				title: `You're invited to ${name}`,
				description: `${invitedYou} to join ${name} as ${offer.roleLabel}.`,
				satisfied: `You already belong to ${name}.`,
				subject: name,
				subjectDetail: `Organization · ${offer.roleLabel}`,
				notice:
					offer.teamNames.length > 0
						? `Accepting also adds you to ${offer.teamNames.join(', ')}.`
						: null,
				acceptLabel: `Join ${name}`,
				openHref: orgOverviewPath(data.org.slug),
				openLabel: `Open ${name}`,
			}
		case 'team':
			return {
				title: `Join the ${offer.teamName} team`,
				description: `${invitedYou} to join the ${offer.teamName} team in ${name}.`,
				satisfied: `You are already on the ${offer.teamName} team.`,
				subject: offer.teamName,
				subjectDetail: `Team in ${name}`,
				notice: offer.joinsOrg
					? `Accepting also makes you a Member of ${name}. Team members can see everything ${name} shares with the team.`
					: `Team members can see everything ${name} shares with the team.`,
				acceptLabel: `Join the ${offer.teamName} team`,
				openHref: routes.orgTeams.href({ orgSlug: data.org.slug }),
				openLabel: 'Open teams',
			}
		case 'resource':
			return {
				title: `Collaborate on ${offer.packageName}`,
				description: `${invitedYou} to ${offer.packageName} with ${offer.presetLabel} access.`,
				satisfied: `You already have this access to ${offer.packageName}.`,
				subject: offer.packageName,
				subjectDetail: `${offer.presetLabel}: ${offer.presetDescription}`,
				notice: offer.outsideCollaborator
					? data.org.personal
						? `You get access to this package only, as an outside collaborator.`
						: `You join as an outside collaborator: you get this package only, not membership in ${name}.`
					: `Accepting adds to the access you already have in ${name}; it never removes any.`,
				acceptLabel: `Accept ${offer.presetLabel} access`,
				openHref: offer.packageHref,
				openLabel: `Open ${offer.packageName}`,
			}
		default: {
			const exhaustive: never = offer
			throw new Error(`Unknown invite link offer: ${String(exhaustive)}`)
		}
	}
}
