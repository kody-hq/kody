/** @jsxImportSource @emotion/react */
import { TextLink } from '../components/text-link.tsx'
import type { CSSObject } from '@emotion/react'
import {
	descriptionCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Public contact page. Channels already published on support, privacy, pricing,
 * FAQ, and security.txt, no invented phone numbers or addresses.
 */
export function ContactRoute() {
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>Contact Kody</h1>
				<p css={pageDescriptionCss}>
					How to reach the people who run the hosted Kody service at kody.codes.
				</p>
			</header>

			<p css={descriptionCss}>
				For help with your account, billing, connections, packages, or anything
				else on the hosted service, email{' '}
				<TextLink tone="muted" href="mailto:support@kody.codes">
					support@kody.codes
				</TextLink>
				. A lot of what you experience as Kody is the agent you connected, if
				something feels off, try the same request with a stronger model before
				writing in; stronger models usually get more out of search, packages,
				and memory.
			</p>

			<p css={descriptionCss}>
				For teams and sales questions about plans beyond Free, email{' '}
				<TextLink tone="muted" href="mailto:kody@kody.codes">
					kody@kody.codes
				</TextLink>
				. Pricing details, including the $0 Free plan caps, are on{' '}
				<TextLink tone="muted" href="/pricing">
					Pricing
				</TextLink>
				.
			</p>

			<p css={descriptionCss}>
				Security reports for the hosted product go to{' '}
				<TextLink tone="muted" href="mailto:me@kentcdodds.com">
					me@kentcdodds.com
				</TextLink>{' '}
				or through{' '}
				<TextLink
					tone="muted"
					href="https://github.com/kody-hq/kody/security/advisories/new"

					target="_blank"
					rel="noreferrer noopener"
				>
					GitHub private vulnerability reporting
				</TextLink>
				. The public policy is in{' '}
				<TextLink
					tone="muted"
					href="https://github.com/kody-hq/kody/blob/main/SECURITY.md"

					target="_blank"
					rel="noreferrer noopener"
				>
					SECURITY.md
				</TextLink>
				, and{' '}
				<TextLink tone="muted" href="/.well-known/security.txt">
					/.well-known/security.txt
				</TextLink>{' '}
				lists the same contacts.
			</p>

			<p css={descriptionCss}>
				Community chat is on the official Discord (
				<TextLink tone="muted" href="/discord">
					join via /discord
				</TextLink>
				). Product source, issues, and pull requests live at{' '}
				<TextLink
					tone="muted"
					href="https://github.com/kody-hq/kody"

					target="_blank"
					rel="noreferrer noopener"
				>
					github.com/kody-hq/kody
				</TextLink>
				. Site blocked by a DNS filter, or signup mail never arrives? See{' '}
				<TextLink tone="muted" href="/docs/cant-open-or-get-mail">
					If you can&apos;t open kody.codes or get mail from us
				</TextLink>
				. More product context is on{' '}
				<TextLink tone="muted" href="/about">
					About
				</TextLink>
				,{' '}
				<TextLink tone="muted" href="/faq">
					FAQ
				</TextLink>
				, and{' '}
				<TextLink tone="muted" href="/support">
					Support
				</TextLink>
				.
			</p>
		</section>
	)
}

const pageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '42rem',
	margin: '0 auto',
}
