/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { type CSSObject } from '@emotion/react'
import {
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

export function SupportRoute() {
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>Support</h1>
				<p css={pageDescriptionCss}>
					For help with the hosted Kody service at kody.codes, email{' '}
					<SiteLink href="mailto:support@kody.codes" css={mutedLinkCss}>
						support@kody.codes
					</SiteLink>
					.
				</p>
				<p css={pageDescriptionCss}>
					A lot of what you experience as Kody is the agent you connected —
					ChatGPT, Claude, Cursor, Codex, or another host. If something feels
					off, try the same request with a better model before writing in.
					Stronger models usually get more out of search, packages, and memory.
				</p>
			</header>

			<p css={pageDescriptionCss}>
				Site blocked by a DNS filter, or signup mail never arrives? See{' '}
				<SiteLink href="/docs/cant-open-or-get-mail" css={mutedLinkCss}>
					If you can't open kody.codes or get mail from us
				</SiteLink>
				.
			</p>
			<p css={{ margin: 0 }}>
				<SiteLink href="/faq" css={mutedLinkCss}>
					FAQ
				</SiteLink>
				{' · '}
				<SiteLink href="/docs/cant-open-or-get-mail" css={mutedLinkCss}>
					Can't open or get mail
				</SiteLink>
				{' · '}
				<SiteLink href="/discord" css={mutedLinkCss}>
					Discord
				</SiteLink>
				{' · '}
				<SiteLink href="/privacy" css={mutedLinkCss}>
					Privacy
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
