/** @jsxImportSource @emotion/react */
import { TextLink } from '../components/text-link.tsx'
import type { CSSObject } from '@emotion/react'
import {
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
					<TextLink tone="muted" href="mailto:support@kody.codes">
						support@kody.codes
					</TextLink>
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
				<TextLink tone="muted" href="/docs/cant-open-or-get-mail">
					If you can't open kody.codes or get mail from us
				</TextLink>
				.
			</p>
			<p css={{ margin: 0 }}>
				<TextLink tone="muted" href="/faq">
					FAQ
				</TextLink>
				{' · '}
				<TextLink tone="muted" href="/docs/cant-open-or-get-mail">
					Can't open or get mail
				</TextLink>
				{' · '}
				<TextLink tone="muted" href="/discord">
					Discord
				</TextLink>
				{' · '}
				<TextLink tone="muted" href="/privacy">
					Privacy
				</TextLink>
			</p>
		</section>
	)
}

const pageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '42rem',
	margin: '0 auto',
}
