/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { type CSSObject } from '@emotion/react'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { termsLastUpdated } from '#client/routes/legal-last-updated.ts'

export function TermsRoute() {
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>Terms and Acceptable Use</h1>
				<p css={pageDescriptionCss}>
					The plain-spoken agreement for creating an account and using Kody.
				</p>
				<p css={lastUpdatedCss}>
					Last updated:{' '}
					<time dateTime={termsLastUpdated}>{termsLastUpdated}</time>
				</p>
			</header>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Who runs Kody</h2>
				<p css={descriptionCss}>
					Kody at kody.codes is operated by Kent C. Dodds. Questions about these
					terms or the service can go to{' '}
					<SiteLink href="mailto:support@kody.codes" css={mutedLinkCss}>
						support@kody.codes
					</SiteLink>
					.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Your account</h2>
				<p css={descriptionCss}>
					You are responsible for activity under your account, including agents
					and packages you connect or run. Keep credentials and secrets private.
					Accounts are for individual use; sharing a login is not supported.
					Give us accurate account information, and tell us promptly if you
					think someone else has access. You may export or delete your account
					data from Account settings.
				</p>
				<p css={descriptionCss}>
					Kody may change your username at the operator&apos;s discretion if it
					is abusive, reserved, impersonating, or otherwise a problem — even if
					it was allowed when you signed up.
				</p>
				<p css={descriptionCss}>
					You must be at least 13 and legally able to agree to these terms. If
					local law requires parental consent, you must have it.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Acceptable use</h2>
				<p css={descriptionCss}>Do not use Kody to:</p>
				<ul css={listCss}>
					<li>Send spam, phishing, or other abusive email</li>
					<li>
						Attack, scrape, or disrupt third-party systems without permission
					</li>
					<li>Probe or abuse other users&apos; accounts or data</li>
					<li>
						Circumvent plan limits, suspensions, or security controls —
						including by creating extra accounts, cycling identity, or farming
						Free compute
					</li>
					<li>Host or distribute malware, or violate applicable law</li>
				</ul>
				<p css={descriptionCss}>
					Outbound email, compute, and storage are shared platform resources.
					Heavy or abusive use may be rate-limited, paused, or suspended. Using
					the full published cap on a busy day is ordinary use, not a violation.
					Free is not a guaranteed compute allotment: we may revoke or restrict
					Free access when we reasonably believe the plan is being gamed or is
					harming the service for other users.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Your agent, your access</h2>
				<p css={descriptionCss}>
					Kody is a set of primitives — code execution, packages, scheduled
					jobs, secrets, email, and integrations — that you and the AI agents
					you connect direct. Kody does not control, review, or supervise what
					your agent (or the AI models behind it) does with those primitives,
					and makes no guarantees about the instructions it will follow or the
					actions it will take.
				</p>
				<p css={descriptionCss}>
					When you connect an integration you register yourself, or store a
					secret, you are authorizing your agent and any code you run to act as
					you with that access. Actions taken with your tokens, keys, and
					connections are your actions: messages sent, data read, changed, or
					deleted, purchases made, and anything else your agent does on a
					third-party service. Those services also have their own terms, which
					you are responsible for honoring.
				</p>
				<p css={descriptionCss}>
					Scope access deliberately: grant only the scopes you need, review
					packages before installing them, and revoke connections you no longer
					use (from Account settings and from the provider&apos;s side). To the
					fullest extent the law permits, Kody and its operator are not liable
					for what your agent, or code you run or install, does with the access
					you grant it.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Plans, billing, and refunds</h2>
				<p css={descriptionCss}>
					The Free plan costs nothing. Paid subscriptions renew through Stripe
					at the price and interval shown when you subscribe. You can manage or
					cancel a subscription from Account settings. Plan limits are listed on
					the{' '}
					<SiteLink href="/pricing" css={mutedLinkCss}>
						Pricing
					</SiteLink>{' '}
					page. Published limits can change; we will give reasonable notice of
					material reductions when practical.
				</p>
				<p css={descriptionCss}>
					Apart from account deletion, there are no automatic refunds. If
					something went wrong, email{' '}
					<SiteLink href="mailto:support@kody.codes" css={mutedLinkCss}>
						support@kody.codes
					</SiteLink>
					. Refund requests are considered case by case. Deleting your account
					cancels any subscription immediately and automatically refunds the
					unused portion of any billing period you have already paid for, to
					your original payment method. Where required by law we collect sales
					tax or VAT at checkout, and business customers can enter a tax ID
					there. Payment processor terms may also apply.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Content and packages</h2>
				<p css={descriptionCss}>
					You retain rights to content you create. Community listings you
					publish are visible to other users under the community rules. Hosted
					package apps run author-supplied code; review packages before
					installing or adopting them. Do not publish secrets or other
					people&apos;s private data.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Public packages</h2>
				<p css={descriptionCss}>
					By publishing a package publicly you grant Kody a license to host,
					display, and distribute it through the community catalog, and you
					grant other Kody users a license to fork and run it under the license
					declared in the package (or, if none is declared, a non-exclusive
					license to fork and run it within Kody). You retain copyright.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Copyright and DMCA notices</h2>
				<p css={descriptionCss}>
					Kody responds to notices of claimed copyright infringement under 17
					U.S.C. §512 concerning public packages and profiles. Send notices to{' '}
					<SiteLink href="mailto:dmca@kody.codes" css={mutedLinkCss}>
						dmca@kody.codes
					</SiteLink>
					. A valid notice must identify the copyrighted work, identify the
					allegedly infringing material with its Kody URL, include your contact
					information, a good-faith statement that use of the material is not
					authorized, a statement under penalty of perjury that the information
					is accurate and that you are the copyright owner or authorized to act
					on the owner&apos;s behalf, and a physical or electronic signature.
					Counter-notices go to the same address. Repeat infringers have their
					community publishing revoked or their accounts terminated.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Suspension and termination</h2>
				<p css={descriptionCss}>
					Operators may suspend or terminate accounts that violate these terms,
					evade limits or a prior suspension, threaten platform reputation
					(including email sending), or put other users at risk. We may act
					without prior notice when we reasonably believe terms are being
					evaded. Free access is revocable. When practical, we will explain the
					reason. You may delete your account at any time.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>The service is provided as-is</h2>
				<p css={descriptionCss}>
					Kody is provided “as is” and “as available.” To the fullest extent the
					law permits, we make no warranties, including warranties of
					merchantability, fitness for a particular purpose, non-infringement,
					or uninterrupted or error-free operation. Keep your own copies of
					anything you cannot afford to lose.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Limits on liability</h2>
				<p css={descriptionCss}>
					To the fullest extent the law permits, Kody and its operator will not
					be liable for indirect, incidental, special, consequential, exemplary,
					or punitive damages, or for lost profits, data, goodwill, or business.
					This includes damages arising from actions your agent, or code you run
					or install, takes with integrations, secrets, or other access you
					grant it — on Kody or on third-party services. Our total liability for
					any claim is limited to the amount you paid Kody during the 12 months
					before the event giving rise to the claim. These limits do not apply
					where the law does not allow them.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Governing law</h2>
				<p css={descriptionCss}>
					These terms are governed by the laws of the State of Utah, without
					regard to conflict-of-law rules, and disputes must be brought in the
					state or federal courts located in Utah, unless applicable law
					requires otherwise.
				</p>
			</section>

			<section css={cardCss}>
				<h2 css={cardTitleCss}>Privacy and changes</h2>
				<p css={descriptionCss}>
					The{' '}
					<SiteLink href="/privacy" css={mutedLinkCss}>
						Privacy
					</SiteLink>{' '}
					page explains how Kody handles data. We may update these terms by
					posting the revised terms here. We will give reasonable notice of
					material changes when practical. Continuing to use Kody after a change
					takes effect means you accept the revised terms.
				</p>
			</section>

			<p css={{ margin: 0 }}>
				<SiteLink href="/pricing" css={mutedLinkCss}>
					Pricing
				</SiteLink>
				{' · '}
				<SiteLink href="/privacy" css={mutedLinkCss}>
					Privacy
				</SiteLink>
				{' · '}
				<SiteLink href="/" css={mutedLinkCss}>
					Back home
				</SiteLink>
			</p>
		</section>
	)
}

const pageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '42rem',
	margin: '0 auto',
}

const lastUpdatedCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const listCss: CSSObject = {
	margin: `${spacing.sm} 0 0`,
	paddingLeft: spacing.lg,
	color: colors.text,
	display: 'grid',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}
