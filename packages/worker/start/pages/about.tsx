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
				<TextLink
					tone="muted"
					href="https://github.com/kody-hq/kody"

					target="_blank"
					rel="noreferrer noopener"
				>
					GitHub
				</TextLink>
				. A free plan is available with no card required to start; plan caps and
				paid options are on{' '}
				<TextLink tone="muted" href="/pricing">
					Pricing
				</TextLink>
				. Privacy, retention, and subprocessors are described on{' '}
				<TextLink tone="muted" href="/privacy">
					Privacy
				</TextLink>
				.
			</p>

			<p css={descriptionCss}>
				Want the capability tour before connecting? Read{' '}
				<TextLink tone="muted" href="/docs/what-is-kody">
					What is Kody?
				</TextLink>{' '}
				or the compact index at{' '}
				<TextLink tone="muted" href="/llms.txt">
					/llms.txt
				</TextLink>
				. Questions and support channels are listed on{' '}
				<TextLink tone="muted" href="/contact">
					Contact
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
