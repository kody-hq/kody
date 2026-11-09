import { readOrgIdFromGrantProps } from '#worker/orgs/oauth-grant.ts'

/** Identify the person's connection to an org, keeping personal subjects stable. */
export function oidcSubject(props: { userId: string; orgId?: string }) {
	const orgId = readOrgIdFromGrantProps(props)
	if (!orgId || orgId === props.userId) return props.userId
	return `org:${encodeURIComponent(orgId)}:user:${encodeURIComponent(props.userId)}`
}

/** Only use with a verified ID token when matching a browser login. */
export function oidcSubjectBelongsToUser(subject: string, userId: string) {
	if (subject === userId) return true
	const orgSubject = /^org:([^:]+):user:([^:]+)$/.exec(subject)
	return orgSubject?.[2] === encodeURIComponent(userId)
}
