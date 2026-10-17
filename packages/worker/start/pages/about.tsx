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
 * Public about page. Facts only from existing product copy (README, privacy,
 * FAQ, support), no invented company biography.
 */
export function AboutRoute() {
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>About Kody</h1>
				<p css={pageDescriptionCss}>
					Kody is Your agents&apos; cloud: the memory, credentials, packages,
					jobs, and apps your AI agent keeps, portable across every MCP host.
				</p>
			</header>

			<p css={descriptionCss}>
				You use Kody from the agent you already pay for, Cursor, ChatGPT,
				Claude, Codex, Copilot, Grok, or any other MCP-capable host. There is no
				separate Kody chat app. Kody does not run its own agent loop and does
				not bill for chat tokens. Your connected agent does the thinking; Kody
				holds the durable result so the work can run again without another model
				in the loop.
			</p>

			<p css={descriptionCss}>
				Accounts work for individuals and teams (organizations, teams, and
				grants). Each account holds isolated packages, jobs, credentials,
				memories, email inboxes, and durable storage. The public MCP surface is
				two tools: <code>search</code> and <code>execute</code>. Connected
				agents also reach the same account over the HTTP Open API at
				api.kody.codes when you mint a scoped token.
			</p>

			<p css={descriptionCss}>
				Kent C. Dodds operates the hosted service at kody.codes and is the data
				controller for that deployment. The project is open on{' '}
				<SiteLink
					href="https://github.com/kody-hq/kody"
					css={mutedLinkCss}
					target="_blank"
					rel="noreferrer noopener"
				>
					GitHub
				</SiteLink>
				. A free plan is available with no card required to start; plan caps and
				paid options are on{' '}
				<SiteLink href="/pricing" css={mutedLinkCss}>
					Pricing
				</SiteLink>
				. Privacy, retention, and subprocessors are described on{' '}
				<SiteLink href="/privacy" css={mutedLinkCss}>
					Privacy
				</SiteLink>
				.
			</p>

			<p css={descriptionCss}>
				Want the capability tour before connecting? Read{' '}
				<SiteLink href="/docs/what-is-kody" css={mutedLinkCss}>
					What is Kody?
				</SiteLink>{' '}
				or the compact index at{' '}
				<SiteLink href="/llms.txt" css={mutedLinkCss}>
					/llms.txt
				</SiteLink>
				. Questions and support channels are listed on{' '}
				<SiteLink href="/contact" css={mutedLinkCss}>
					Contact
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
