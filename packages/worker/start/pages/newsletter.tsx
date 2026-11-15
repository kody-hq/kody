/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import {
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileResponseFieldName,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
// Top-level `import type` is erased; an inline `{ type X }` would keep a
// side-effect import that drags worker code into the client build.
// oxlint-disable-next-line import/consistent-type-specifier-style
import type {
	NewsletterPageData,
	NewsletterPageError,
} from '#start/server/newsletter'
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getAlertCardCss,
	getPrimaryButtonCss,
	inputCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	sectionTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { useActor } from '@xstate/react'
import { useEffect, type FormEvent } from 'react'
import { submissionGateState } from '#client/routes/submission-gate-state.ts'
import { sendUiEvent } from '#client/ui-actor.ts'
import { SiteLink } from '../components/site-link.tsx'

// Keeps the card's grid spacing while letting the no-JavaScript note hide
// every control at once.
const fieldsCss: CSSObject = { display: 'contents' }

function newsletterErrorText(error: NewsletterPageError) {
	switch (error) {
		case 'invalid_email':
			return 'That email address does not look right. Check it and try again.'
		case 'rate_limited':
			return 'Too many sign-ups from here. Wait a few minutes and try again.'
		case 'unavailable':
			return 'Sign-up is not available right now. Please try again later.'
		case 'verification_failed':
			return 'We could not confirm you are human. Complete the check and try again.'
		case 'invalid_link':
			return 'That confirmation link has expired or was already used. Enter your email to get a new one.'
		default: {
			const exhaustive: never = error
			return exhaustive
		}
	}
}

/** Public sign-up for the What's New in Kody newsletter. */
export function NewsletterRoute(props: { data: NewsletterPageData }) {
	const { data } = props
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<span css={pageEyebrowCss}>Newsletter</span>
				<h1 css={pageTitleCss}>What&apos;s New in Kody</h1>
				<p css={pageDescriptionCss}>
					One short email every other week about what shipped in Kody: new
					capabilities, packages worth trying, and what is coming next. No
					account needed, and you can unsubscribe from any email.
				</p>
			</header>

			{data.status === 'confirmed' ? (
				<div css={getAlertCardCss('info')} role="status">
					<h2 css={sectionTitleCss}>You are subscribed</h2>
					<p css={statusTextCss}>
						Thanks for confirming. What&apos;s New in Kody will show up in your
						inbox every other week.
					</p>
				</div>
			) : data.status === 'sent' ? (
				<div css={getAlertCardCss('info')} role="status">
					<h2 css={sectionTitleCss}>Check your inbox</h2>
					<p css={statusTextCss}>
						If that address can get the newsletter, a confirmation link is on
						its way. You are not subscribed until you open it and confirm. The
						link works for 7 days.
					</p>
				</div>
			) : (
				<SignupForm
					error={data.error}
					turnstileSiteKey={data.turnstileSiteKey}
				/>
			)}

			{data.latest ? (
				<article css={cardCss} aria-labelledby="newsletter-latest-title">
					<span css={pageEyebrowCss}>Latest from the blog</span>
					<h2 css={sectionTitleCss} id="newsletter-latest-title">
						<SiteLink href={`/blog/${data.latest.slug}`}>
							{data.latest.title}
						</SiteLink>
					</h2>
					<p css={descriptionCss}>{data.latest.description}</p>
					<SiteLink href="/blog" css={mutedLinkCss}>
						All posts
					</SiteLink>
				</article>
			) : null}
		</section>
	)
}

/**
 * Pending state for a plain form post. The gate refuses a second submit even
 * before React has rendered the first, and reopens when the browser restores
 * the page from its back/forward cache.
 */
function useNativeSubmitGate() {
	const [snapshot, , actor] = useActor(submissionGateState)
	useEffect(() => {
		function pageshow(event: PageTransitionEvent) {
			if (event.persisted) sendUiEvent(actor, { type: 'SETTLED' })
		}
		window.addEventListener('pageshow', pageshow)
		return () => window.removeEventListener('pageshow', pageshow)
	}, [actor])
	return {
		pending: snapshot.matches('running'),
		onSubmit(event: FormEvent<HTMLFormElement>) {
			if (!sendUiEvent(actor, { type: 'SUBMIT' })) event.preventDefault()
		},
	}
}

function SignupForm(props: {
	error: NewsletterPageError | null
	turnstileSiteKey: string | null
}) {
	const { pending, onSubmit } = useNativeSubmitGate()
	const { turnstileSiteKey } = props
	useEffect(() => {
		if (!turnstileSiteKey) return
		void renderTurnstileWidgets(turnstileSiteKey)
		// A page restored from the back/forward cache holds a spent token.
		function pageshow(event: PageTransitionEvent) {
			if (event.persisted) resetTurnstileWidgets()
		}
		window.addEventListener('pageshow', pageshow)
		return () => window.removeEventListener('pageshow', pageshow)
	}, [turnstileSiteKey])
	const errorId = 'newsletter-signup-error'
	const emailInvalid = props.error === 'invalid_email'
	return (
		<form
			method="post"
			action="/newsletter"
			css={cardCss}
			data-testid="newsletter-signup-form"
			aria-busy={pending}
			// The post is a normal form submission; the button shows progress
			// until the page navigates.
			onSubmit={(event) => {
				// The widget lives in a shadow root, which a native form post
				// does not include, so its token is copied into the form.
				const form = event.currentTarget
				const field = form.elements.namedItem(turnstileResponseFieldName)
				if (field instanceof HTMLInputElement) {
					// Cleared first so a token left by an earlier submit never
					// outranks the widget's current one.
					field.value = ''
					field.value = readPublicFormProtection(new FormData(form), form)[
						turnstileResponseFieldName
					]
				}
				onSubmit(event)
			}}
		>
			{props.error ? (
				<p css={getAlertCardCss('error')} role="alert" id={errorId}>
					{newsletterErrorText(props.error)}
				</p>
			) : null}
			{turnstileSiteKey ? (
				// The human check needs JavaScript, so without it the fields
				// are replaced by this note instead of a form that cannot work.
				<noscript>
					<p css={descriptionCss} data-testid="newsletter-no-javascript-note">
						Signing up needs JavaScript for a quick human check. Turn on
						JavaScript and reload this page to subscribe.
					</p>
					<style
						dangerouslySetInnerHTML={{
							__html: '[data-newsletter-fields]{display:none!important}',
						}}
					/>
				</noscript>
			) : null}
			<div data-newsletter-fields css={fieldsCss}>
				<input
					type="text"
					name={honeypotFieldName}
					tabIndex={-1}
					aria-hidden="true"
					defaultValue=""
					{...passwordManagerIgnoreProps}
					css={honeypotCss}
				/>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Email address</span>
					<input
						type="email"
						name="email"
						required
						autoComplete="email"
						inputMode="email"
						spellCheck={false}
						maxLength={254}
						placeholder="you@example.com"
						aria-invalid={emailInvalid || undefined}
						aria-describedby={props.error ? errorId : undefined}
						css={inputCss}
					/>
				</label>
				{turnstileSiteKey ? (
					<>
						<div className={turnstileWidgetClassName}></div>
						<input type="hidden" name={turnstileResponseFieldName} />
					</>
				) : null}
				<button
					type="submit"
					css={primaryButtonCss}
					aria-disabled={pending || undefined}
					onClick={(event) => {
						// A disabled button would cancel the native submission in
						// some browsers, so repeat clicks are ignored instead.
						if (pending) event.preventDefault()
					}}
				>
					{pending ? 'Sending confirmation link...' : 'Subscribe'}
				</button>
			</div>
			<p css={descriptionCss}>
				We email a confirmation link first. Nothing is sent until you confirm.
				See the <SiteLink href="/privacy">privacy policy</SiteLink>.
			</p>
		</form>
	)
}

/** Page behind the emailed link: confirming takes a deliberate button press. */
export function NewsletterConfirmRoute(props: { token: string }) {
	const { pending, onSubmit } = useNativeSubmitGate()
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<span css={pageEyebrowCss}>Newsletter</span>
				<h1 css={pageTitleCss}>Confirm your subscription</h1>
				<p css={pageDescriptionCss}>
					One short email every other week about what is new in Kody.
				</p>
			</header>
			{props.token ? (
				<form
					method="post"
					action="/newsletter/confirm"
					css={cardCss}
					data-testid="newsletter-confirm-form"
					aria-busy={pending}
					onSubmit={onSubmit}
				>
					<input type="hidden" name="token" value={props.token} />
					<button
						type="submit"
						css={primaryButtonCss}
						aria-disabled={pending || undefined}
						onClick={(event) => {
							if (pending) event.preventDefault()
						}}
					>
						{pending ? 'Confirming...' : 'Yes, subscribe me'}
					</button>
					<p css={descriptionCss}>
						Did not ask for this? Close this page and nothing will be sent.
					</p>
				</form>
			) : (
				<p css={getAlertCardCss('error')} role="alert">
					This confirmation link is incomplete.{' '}
					<SiteLink href="/newsletter">Get a new link</SiteLink>.
				</p>
			)}
		</section>
	)
}

const pageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '36rem',
	margin: '0 auto',
}

const primaryButtonCss = getPrimaryButtonCss()

const statusTextCss: CSSObject = { margin: 0 }

const honeypotCss: CSSObject = {
	position: 'absolute',
	left: '-10000px',
	width: '1px',
	height: '1px',
	overflow: 'hidden',
}
