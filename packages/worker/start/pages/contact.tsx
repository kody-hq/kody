/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { type CSSObject } from '@emotion/react'
import {
	descriptionCss,
	mutedLinkCss,
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
				<SiteLink href="mailto:support@kody.codes" css={mutedLinkCss}>
					support@kody.codes
				</SiteLink>
				. A lot of what you experience as Kody is the agent you connected, if
				something feels off, try the same request with a stronger model before
				writing in; stronger models usually get more out of search, packages,
				and memory.
			</p>

			<p css={descriptionCss}>
				For teams and sales questions about plans beyond Free, email{' '}
				<SiteLink href="mailto:kody@kody.codes" css={mutedLinkCss}>
					kody@kody.codes
				</SiteLink>
				. Pricing details, including the $0 Free plan caps, are on{' '}
				<SiteLink href="/pricing" css={mutedLinkCss}>
					Pricing
				</SiteLink>
				.
			</p>

			<p css={descriptionCss}>
				Security reports for the hosted product go to{' '}
				<SiteLink href="mailto:me@kentcdodds.com" css={mutedLinkCss}>
					me@kentcdodds.com
				</SiteLink>{' '}
				or through{' '}
				<SiteLink
					href="https://github.com/kody-hq/kody/security/advisories/new"
					css={mutedLinkCss}
					target="_blank"
					rel="noreferrer noopener"
				>
					GitHub private vulnerability reporting
				</SiteLink>
				. The public policy is in{' '}
				<SiteLink
					href="https://github.com/kody-hq/kody/blob/main/SECURITY.md"
					css={mutedLinkCss}
					target="_blank"
					rel="noreferrer noopener"
				>
					SECURITY.md
				</SiteLink>
				, and{' '}
				<SiteLink href="/.well-known/security.txt" css={mutedLinkCss}>
					/.well-known/security.txt
				</SiteLink>{' '}
				lists the same contacts.
			</p>

			<p css={descriptionCss}>
				Community chat is on the official Discord (
				<SiteLink href="/discord" css={mutedLinkCss}>
					join via /discord
				</SiteLink>
				). Product source, issues, and pull requests live at{' '}
				<SiteLink
					href="https://github.com/kody-hq/kody"
					css={mutedLinkCss}
					target="_blank"
					rel="noreferrer noopener"
				>
					github.com/kody-hq/kody
				</SiteLink>
				. Site blocked by a DNS filter, or signup mail never arrives? See{' '}
				<SiteLink href="/docs/cant-open-or-get-mail" css={mutedLinkCss}>
					If you can&apos;t open kody.codes or get mail from us
				</SiteLink>
				. More product context is on{' '}
				<SiteLink href="/about" css={mutedLinkCss}>
					About
				</SiteLink>
				,{' '}
				<SiteLink href="/faq" css={mutedLinkCss}>
					FAQ
				</SiteLink>
				, and{' '}
				<SiteLink href="/support" css={mutedLinkCss}>
					Support
				</SiteLink>
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
