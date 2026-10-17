/** @jsxImportSource @emotion/react */
import {
	joinOrganization,
	declineOrganizationInvite,
} from '#start/server/join-organization'
import { captureClientException } from '#client/sentry-client.ts'
import { inviteLinkOfferCopy } from '#universal/invite-link-offer-copy.ts'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { type CSSObject } from '@emotion/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { isRedirect, useRouter, useRouteContext } from '@tanstack/react-router'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildErrorAgentPrompt } from '#universal/error-agent-prompt.ts'
import { renderIcon } from '../components/icon.tsx'
import { UserAvatar } from '../components/user-avatar.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { type OrgInviteJoinLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	cardCss,
	nativeDisclosureCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { permissionsMutationOptions } from '../permissions-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'

function inviteErrorPrompt(error: string, slug?: string) {
	return buildErrorAgentPrompt({
		activity: slug
			? 'Joining an organization from an invite link.'
			: 'Opening an organization invite link.',
		errorCode: slug ? 'org_invite_join_failed' : 'org_invite_unusable',
		errorMessage: error,
		ids: { path: '/join', ...(slug ? { orgSlug: slug } : {}) },
		likelyCause: slug
			? 'The invite could not be accepted (expired, already used, or permission issue).'
			: 'The invite expired, was revoked, or the token is invalid.',
		nextSteps: [
			'Ask the org owner to send a fresh invite.',
			'Confirm I am signed in as the invited email.',
		],
		kodyTools: ['search({ entity: "guide:organizations" })'],
		docs: ['search({ entity: "guide:organizations" })'],
	})
}
export function OrgInviteJoinPage({ data }: { data: OrgInviteJoinLoaderData }) {
	const router = useRouter(),
		client = useQueryClient(),
		capture = useSubmitterScope()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const mutation = useMutation({
		mutationFn: async ({
			token,
			action,
		}: {
			action: 'accept' | 'decline'
			token: string
			actorKey: string | null
		}) => {
			const result =
				action === 'decline'
					? await declineOrganizationInvite({ data: token })
					: await joinOrganization({ data: token })
			return {
				needsLogin: false,
				alreadyMember: 'alreadyMember' in result ? result.alreadyMember : false,
				redirectTo: result.redirectTo,
			}
		},
		...permissionsMutationOptions(client, actorKey),
	})
	function reconcileFailedAcceptance(error: unknown, active: () => boolean) {
		if (!active() || isRedirect(error)) return
		// This entry read also records a pending invitation. Reconcile acceptance failures
		// (including committed writes whose response was lost), but do not rerun
		// it for a decline whose response could be lost and recreate its pending row.
		// Per-call mutation callbacks do not await returned promises.
		void router
			.invalidate({ filter: (match) => match.routeId === '/join/$token' })
			.catch(captureClientException)
	}
	if (!data.ok)
		return (
			<section css={pageCss}>
				<header css={pageHeaderCss}>
					<h1 css={pageTitleCss}>Invite link</h1>
					<p css={pageDescriptionCss}>This invite link cannot be used.</p>
				</header>
				<div css={cardCss}>
					<p role="alert" css={bodyCss}>
						{data.error}
					</p>
					<ErrorAgentPromptButton prompt={inviteErrorPrompt(data.error)} />
					<p css={footerCss}>
						<SiteLink href="/" css={mutedLinkCss}>
							Go home
						</SiteLink>
					</p>
				</div>
			</section>
		)
	const copy = inviteLinkOfferCopy(data)
	const name = data.org.displayName?.trim() || data.org.slug
	const loginHref = `/login?redirectTo=${encodeURIComponent(routes.orgInviteJoin.href({ token: data.token }))}`,
		signupHref = `/signup?redirectTo=${encodeURIComponent(routes.orgInviteJoin.href({ token: data.token }))}`
	const message =
		mutation.error?.message ??
		(mutation.isSuccess && !mutation.data.needsLogin
			? mutation.data.alreadyMember
				? copy.satisfied
				: mutation.variables.action === 'decline'
					? 'Invite declined.'
					: 'Invite accepted.'
			: null)
	return (
		<section
			css={pageCss}
			data-testid="org-invite-join"
			data-invite-kind={data.offer.kind}
		>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>{copy.title}</h1>
				<p css={pageDescriptionCss}>
					{data.alreadyMember ? copy.satisfied : copy.description}
				</p>
			</header>
			<div css={cardCss}>
				<div css={orgRowCss}>
					<UserAvatar
						displayName={name}
						avatarUrl={data.org.avatarUrl}
						size={56}
						variant="well"
					/>
					<div css={orgTextCss}>
						<p css={orgNameCss}>{copy.subject}</p>
						<p css={orgDetailCss}>{copy.subjectDetail}</p>
					</div>
				</div>
				{copy.notice && !data.alreadyMember ? (
					<p css={noticeCss} data-testid="org-invite-join-notice">
						{copy.notice}
					</p>
				) : null}
				{message ? (
					<>
						<p
							role={mutation.error ? 'alert' : 'status'}
							css={mutation.error ? errorMessageCss : infoMessageCss}
						>
							{message}
						</p>
						{mutation.error ? (
							<ErrorAgentPromptButton
								prompt={inviteErrorPrompt(message, data.org.slug)}
							/>
						) : null}
					</>
				) : null}
				{data.alreadyMember ? (
					<p css={footerCss}>
						<SiteLink href={copy.openHref} css={getPrimaryButtonCss()}>
							{copy.openLabel}
						</SiteLink>
					</p>
				) : data.authenticated ? (
					<div css={actionsCss}>
						<button
							type="button"
							disabled={mutation.isPending || mutation.isSuccess}
							data-testid="org-invite-join-confirm"
							css={[getPrimaryButtonCss(), iconButtonCss]}
							onClick={() => {
								const active = capture()
								mutation.mutate(
									{ token: data.token, actorKey, action: 'accept' },
									{
										onError: (error) =>
											reconcileFailedAcceptance(error, active),
										onSuccess: (result) => {
											if (active())
												void router.navigate({
													href: result.needsLogin
														? loginHref
														: result.redirectTo,
												})
										},
									},
								)
							}}
						>
							{renderIcon('plus', { size: '1.05rem' })}
							{mutation.isPending && mutation.variables.action === 'accept'
								? 'Accepting…'
								: copy.acceptLabel}
						</button>
						<button
							type="button"
							disabled={mutation.isPending || mutation.isSuccess}
							data-testid="org-invite-join-decline"
							css={getSecondaryButtonCss()}
							onClick={() => {
								const active = capture()
								mutation.mutate(
									{ token: data.token, actorKey, action: 'decline' },
									{
										onSuccess: (result) => {
											if (active())
												void router.navigate({ href: result.redirectTo })
										},
									},
								)
							}}
						>
							{mutation.isPending && mutation.variables.action === 'decline'
								? 'Declining…'
								: 'Decline'}
						</button>
					</div>
				) : (
					<div css={actionsCss}>
						<SiteLink href={loginHref} css={getPrimaryButtonCss()}>
							Sign in to accept
						</SiteLink>
						<SiteLink href={signupHref} css={getSecondaryButtonCss()}>
							Create an account
						</SiteLink>
					</div>
				)}
				<details css={detailsCss} data-testid="org-invite-join-details">
					<summary>Details</summary>
					<dl css={detailListCss}>
						<div>
							<dt>Organization</dt>
							<dd>
								{name} (@{data.org.slug})
							</dd>
						</div>
						{data.invitedBy ? (
							<div>
								<dt>Invited by</dt>
								<dd>{data.invitedBy}</dd>
							</div>
						) : null}
						<div>
							<dt>Expires</dt>
							<dd>{formatTimestampDate(data.expiresAt)}</dd>
						</div>
					</dl>
				</details>
			</div>
		</section>
	)
}
const pageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '36rem',
}

const bodyCss: CSSObject = {
	margin: 0,
	color: colors.text,
	fontSize: typography.fontSize.base,
	lineHeight: 1.5,
}

const footerCss: CSSObject = {
	margin: `${spacing.lg} 0 0`,
}

const orgRowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	marginBottom: spacing.lg,
}

const orgTextCss: CSSObject = {
	display: 'grid',
	gap: '0.2rem',
	minWidth: 0,
}

const orgNameCss: CSSObject = {
	margin: 0,
	fontWeight: 650,
	fontSize: typography.fontSize.lg,
}

const orgDetailCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const actionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
}

const infoMessageCss: CSSObject = {
	margin: `0 0 ${spacing.md}`,
	color: colors.text,
}

const errorMessageCss: CSSObject = {
	margin: `0 0 ${spacing.md}`,
	color: colors.danger,
}

const noticeCss = {
	margin: `0 0 ${spacing.lg}`,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.5,
}

const detailsCss = {
	...nativeDisclosureCss,
	marginTop: spacing.lg,
}

const detailListCss = {
	margin: 0,
	display: 'grid',
	gap: spacing.sm,
	'& dt': {
		fontSize: typography.fontSize.sm,
		color: colors.textMuted,
	},
	'& dd': {
		margin: 0,
		color: colors.text,
		overflowWrap: 'anywhere' as const,
	},
}

const iconButtonCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
}
