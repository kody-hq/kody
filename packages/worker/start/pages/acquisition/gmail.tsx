/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { gmail } from '#universal/acquisition/gmail.ts'
import { routes } from '#universal/routes.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
const threads = [
	{
		sender: 'Maya Chen',
		subject: 'Can we move the review?',
		preview: 'Thursday afternoon would work better for our team.',
		message:
			'Hi! Could we move the design review to Thursday afternoon? We need another day to collect feedback from the team.',
		draft:
			'Hi Maya, thanks for the heads-up. Thursday afternoon could work. What time were you thinking? I’ll confirm once we have a slot.',
		note: 'Asks for a time. Does not claim to have checked your calendar.',
	},
	{
		sender: 'Alex Rivera',
		subject: 'The proposal looks good',
		preview: 'One question about the handoff before we sign.',
		message:
			'The proposal looks good. Before we sign, could you clarify what happens after launch and who owns the handoff?',
		draft:
			'Hi Alex, glad the proposal is looking good. I’ll pull together the handoff details and confirm the post-launch responsibilities before you sign.',
		note: 'Leaves unverified contract details for you to confirm.',
	},
	{
		sender: 'Jordan Lee',
		subject: 'Receipt for September',
		preview: 'Attaching the receipt you asked for.',
		message:
			'Here’s the September receipt. Let me know if you need anything else for your records.',
		draft:
			'Hi Jordan, thanks for sending the September receipt. I’ll take a look and let you know if anything else is needed.',
		note: 'Acknowledges the message without claiming an attachment was processed.',
	},
]
export function GmailPage() {
	const [selected, setSelected] = useState(0)
	const [showDraft, setShowDraft] = useState(false)
	const thread = threads[selected]!
	return (
		<article css={pageCss}>
			<header className="intro">
				<h1>{gmail.title}</h1>
				<div className="intro-copy">
					<p>
						Let your agent help with the inbox. It can prepare replies for you
						to review, and you can save the workflow to use again.
					</p>
					<SiteLink href={routes.onboarding.href()} css={getPillButtonCss()}>
						Connect your agent
					</SiteLink>
				</div>
			</header>
			<section
				className="mail-workspace"
				aria-label="Illustrative Gmail draft workflow"
			>
				<div className="workspace-bar">
					<span>
						<span className="mail-mark" aria-hidden="true">
							✉
						</span>{' '}
						Inbox → review → draft
					</span>
					<span className="example-label">
						Interactive example · fictional messages
					</span>
				</div>
				<div className="mail-columns">
					<div className="inbox">
						<h2>Choose a thread</h2>
						<div
							className="thread-list"
							role="group"
							aria-label="Example messages"
						>
							{threads.map((item, index) => (
								<button
									key={item.sender}
									type="button"
									aria-pressed={index === selected ? 'true' : 'false'}
									onClick={() => {
										setSelected(index)
										setShowDraft(false)
									}}
								>
									<span className="sender">{item.sender}</span>
									<strong>{item.subject}</strong>
									<span className="preview">{item.preview}</span>
								</button>
							))}
						</div>
						<p className="scope-note">
							Only the selected message is used in this example.
						</p>
					</div>
					<div className="message-pane" aria-live="polite">
						<div className="message-heading">
							<span>From: {thread.sender}</span>
							<h2>{thread.subject}</h2>
						</div>
						<p className="message-text">{thread.message}</p>
						<div className="draft-area">
							{showDraft ? (
								<>
									<div className="draft-heading">
										<strong>Suggested reply</strong>
										<span>Not sent</span>
									</div>
									<p>{thread.draft}</p>
									<p className="draft-note">{thread.note}</p>
									<button
										className="text-button"
										type="button"
										onClick={() => {
											setShowDraft(false)
										}}
									>
										Back to message
									</button>
								</>
							) : (
								<>
									<p>
										Prepare a reply you can review, with no option for the tool
										to send it.
									</p>
									<button
										type="button"
										className="prepare"
										onClick={() => {
											setShowDraft(true)
										}}
									>
										Preview a suggested draft <span aria-hidden="true">↗</span>
									</button>
								</>
							)}
						</div>
					</div>
				</div>
				<div className="workspace-foot">
					<span>
						Illustration only. This page doesn’t connect to Gmail or create a
						draft.
					</span>
					<SiteLink href="/docs/locked-gmail-drafts">
						Build the real workflow ↗
					</SiteLink>
				</div>
			</section>
			<section className="choice">
				<h2>Keep the inbox workflow you worked out together.</h2>
				<div>
					<p>
						Ask your agent to sort through the messages you choose, prepare
						replies, and save the steps that worked.
					</p>
					<p>
						Kody keeps that workflow as a package, so you can run it again,
						connect it to another service, or use it from another agent.
					</p>
					<SiteLink href="/docs/packages-integrations-mcp">
						Build a reusable Gmail workflow ↗
					</SiteLink>
				</div>
			</section>
			<section className="boundary">
				<div className="boundary-copy">
					<h2>“Don’t send” should be part of the tool.</h2>
					<p>
						Build a package that can create drafts but has no tool for sending
						them. Lock its published code, then lock the Google integration to
						that approved package.
					</p>
					<p className="important">
						Google has no drafts-only OAuth scope. Its compose scope can manage
						drafts and send mail. Locking the package alone doesn’t change those
						Google permissions.
					</p>
					<SiteLink href="/docs/locked-gmail-drafts">
						Read the complete locking guide ↗
					</SiteLink>
				</div>
				<ol className="boundary-steps">
					<li>
						<strong>Connect Google</strong>
						<p>Approve the narrowest scopes needed for your workflow.</p>
						<SiteLink href="/docs/google">Connection guide</SiteLink> ·{' '}
						<SiteLink href="/docs/google-oauth">OAuth setup</SiteLink>
					</li>
					<li>
						<strong>Test one draft</strong>
						<p>
							Choose the source message. Inspect the result. Don’t include a
							send export.
						</p>
					</li>
					<li>
						<strong>Lock the package and its access</strong>
						<p>
							Lock the published package and its integration usage. You’ll need
							to use the website to unlock it.
						</p>
					</li>
				</ol>
			</section>
			<section className="beyond">
				<h2>Turn those emails into a report.</h2>
				<div className="workflow-row">
					<span>Labeled messages</span>
					<span aria-hidden="true">→</span>
					<span>A saved package</span>
					<span aria-hidden="true">→</span>
					<span>Your weekly project report</span>
				</div>
				<div className="beyond-copy">
					<p>
						Build a package that turns selected emails into a report or collects
						receipts into another service. Decide what data can leave your inbox
						and who should review the output.
					</p>
					<p>
						Keep processing progress in package storage so the next run knows
						which messages it already handled. Build reply rules, such as
						quoting the thread, into the package and document its defaults.
					</p>
				</div>
				<SiteLink href="/use-cases/scheduled-workflows">
					Put a reusable workflow on a schedule ↗
				</SiteLink>
			</section>
			<section className="start" id="try-it">
				<div>
					<h2>Start with one draft.</h2>
					<p>
						Connect your agent to Kody, then ask it to build a workflow you can
						inspect before you use it.
					</p>
					<SiteLink href={routes.onboarding.href()} css={getPillButtonCss()}>
						Get started with Kody
					</SiteLink>
				</div>
				<div className="prompt">
					<blockquote>{gmail.prompt}</blockquote>
					<CopyTextButton
						value={gmail.prompt}
						idleLabel="Copy prompt"
						variant="pill"
					/>
				</div>
			</section>
			<nav className="reading" aria-label="Gmail integration references">
				<SiteLink href="https://developers.google.com/workspace/gmail/api/auth/scopes">
					Google Gmail scopes
				</SiteLink>
				<SiteLink href="/use-cases/claude-code-custom-tools">
					Build reusable custom tools
				</SiteLink>
				<SiteLink href="/integrations/claude">Connect Claude to Kody</SiteLink>
				<SiteLink href={routes.pricing.href()}>Pricing and limits</SiteLink>
			</nav>
		</article>
	)
}
const pageCss = {
	maxWidth: '1160px',
	marginInline: 'auto',
	padding: '3rem 2rem 5rem',
	color: colors.text,
	'& *': { boxSizing: 'border-box' as const },
	'& h1, & h2, & h3': {
		fontFamily: typography.fontFamilyDisplay,
		fontWeight: 550,
		margin: 0,
		textWrap: 'balance' as const,
	},
	'& h1': { fontSize: '3.7rem', lineHeight: 1.05, maxWidth: '640px' },
	'& h2': { fontSize: '2.25rem', lineHeight: 1.15 },
	'& p': { lineHeight: 1.7 },
	'& button': { font: 'inherit', cursor: 'pointer' },
	'& button:focus-visible, & a:focus-visible': {
		outline: `3px solid ${colors.primaryText}`,
		outlineOffset: '4px',
	},
	'& .intro': {
		display: 'grid',
		gridTemplateColumns: '1.25fr 1fr',
		gap: '3rem',
		alignItems: 'end',
		paddingBlock: '1.5rem 3rem',
	},
	'& .intro-copy p': {
		margin: '0 0 1.5rem',
		fontSize: '1.15rem',
		color: colors.textMuted,
	},
	'& .mail-workspace': {
		border: `1px solid ${colors.border}`,
		borderRadius: '16px',
		overflow: 'hidden',
		boxShadow: '0 20px 60px #0000000c',
	},
	'& .workspace-bar': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
		alignItems: 'center',
		padding: '1rem 1.5rem',
		borderBottom: `1px solid ${colors.border}`,
		background: colors.surface,
		fontWeight: 600,
	},
	'& .mail-mark': {
		color: colors.primaryText,
		marginRight: '0.5rem',
		fontSize: '1.5rem',
	},
	'& .example-label': {
		fontSize: '0.75rem',
		fontWeight: 400,
		color: colors.textMuted,
	},
	'& .mail-columns': { display: 'grid', gridTemplateColumns: '0.85fr 1.5fr' },
	'& .inbox': {
		padding: '1.5rem 0',
		borderRight: `1px solid ${colors.border}`,
		background: colors.surface,
	},
	'& .inbox h2': {
		fontFamily: typography.fontFamily,
		fontSize: '0.85rem',
		padding: '0 1.5rem 1rem',
	},
	'& .thread-list button': {
		display: 'grid',
		gap: '0.4rem',
		width: '100%',
		padding: '1.15rem 1.5rem',
		textAlign: 'left' as const,
		background: 'transparent',
		color: colors.text,
		border: 0,
		borderLeft: '3px solid transparent',
		borderBottom: `1px solid ${colors.border}`,
	},
	'& .thread-list button[aria-pressed="true"]': {
		background: colors.primarySoft,
		borderLeftColor: colors.primaryText,
	},
	'& .thread-list button:hover': { background: colors.primarySoftest },
	'& .sender': { fontSize: '0.8rem', color: colors.textMuted },
	'& .thread-list strong': { fontSize: '0.95rem', fontWeight: 600 },
	'& .preview': {
		fontSize: '0.8rem',
		color: colors.textMuted,
		lineHeight: 1.5,
	},
	'& .scope-note': {
		fontSize: '0.75rem',
		color: colors.textMuted,
		padding: '0 1.5rem',
		marginTop: '1.5rem',
	},
	'& .message-pane': { padding: '2rem', minHeight: '465px' },
	'& .message-heading span': { fontSize: '0.85rem', color: colors.textMuted },
	'& .message-heading h2': {
		fontFamily: typography.fontFamily,
		fontSize: '1.35rem',
		marginTop: '0.6rem',
	},
	'& .message-text': { marginBlock: '1.5rem 2rem', fontSize: '0.98rem' },
	'& .draft-area': {
		borderTop: `1px dashed ${colors.border}`,
		paddingTop: '1.5rem',
		fontSize: '0.95rem',
	},
	'& .draft-area > p:first-child': { color: colors.textMuted, marginTop: 0 },
	'& .prepare': {
		display: 'inline-flex',
		gap: '1.5rem',
		padding: '0.8rem 1rem',
		border: `1px solid ${colors.primaryText}`,
		borderRadius: '6px',
		background: colors.primarySoft,
		color: colors.primaryText,
		textAlign: 'left' as const,
	},
	'& .draft-heading': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
	},
	'& .draft-heading span': { color: colors.primaryText, fontSize: '0.8rem' },
	'& .draft-note': {
		color: colors.textMuted,
		fontSize: '0.8rem',
		borderLeft: `2px solid ${colors.primaryText}`,
		paddingLeft: '0.75rem',
	},
	'& .text-button': {
		color: colors.primaryText,
		border: 0,
		padding: 0,
		background: 'transparent',
		textDecoration: 'underline',
		textUnderlineOffset: '0.2em',
	},
	'& .workspace-foot': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
		flexWrap: 'wrap' as const,
		padding: '1rem 1.5rem',
		borderTop: `1px solid ${colors.border}`,
		fontSize: '0.75rem',
		color: colors.textMuted,
	},
	'& .choice': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		paddingBlock: '5rem',
	},
	'& .choice p:first-child': { marginTop: 0 },
	'& .boundary': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		padding: '3rem',
		background: colors.primarySoftest,
		borderBlock: `1px solid ${colors.border}`,
	},
	'& .important': {
		borderLeft: `3px solid ${colors.primaryText}`,
		paddingLeft: '1rem',
		fontSize: '0.9rem',
	},
	'& .boundary-steps': { margin: 0, paddingLeft: '1.5rem' },
	'& .boundary-steps li': { padding: '0 0 1.5rem 0.75rem', lineHeight: 1.7 },
	'& .boundary-steps li::marker': {
		color: colors.primaryText,
		fontFamily: typography.fontFamilyMono,
	},
	'& .boundary-steps p': { margin: '0.4rem 0', fontSize: '0.95rem' },
	'& .boundary-steps a': { fontSize: '0.85rem' },
	'& .beyond': { paddingBlock: '5rem' },
	'& .workflow-row': {
		display: 'flex',
		gap: '1.5rem',
		alignItems: 'center',
		borderBlock: `1px solid ${colors.border}`,
		paddingBlock: '1.5rem',
		marginTop: '2rem',
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.95rem',
	},
	'& .workflow-row span[aria-hidden]': { color: colors.primaryText },
	'& .beyond-copy': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '3rem',
		marginBlock: '0.5rem 1rem',
	},
	'& .start': {
		display: 'grid',
		gridTemplateColumns: '0.9fr 1.1fr',
		gap: '3rem',
		paddingTop: '3rem',
		borderTop: `1px solid ${colors.border}`,
	},
	'& .start p': { color: colors.textMuted, marginBottom: '1.5rem' },
	'& .prompt': {
		padding: '1.5rem',
		background: colors.surface,
		border: `1px solid ${colors.border}`,
		borderRadius: '8px',
	},
	'& blockquote': {
		margin: '0 0 1.5rem',
		fontSize: '0.95rem',
		lineHeight: 1.75,
	},
	'& .reading': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		gap: '1.25rem 2rem',
		marginTop: '3rem',
		fontSize: '0.85rem',
	},
	'@media (max-width: 760px)': {
		padding: '2rem 1.25rem 3rem',
		'& h1': { fontSize: '2.7rem' },
		'& h2': { fontSize: '1.9rem' },
		'& .intro, & .choice, & .boundary, & .start, & .beyond-copy': {
			gridTemplateColumns: '1fr',
			gap: '1.5rem',
		},
		'& .workspace-bar': {
			alignItems: 'start',
			flexDirection: 'column' as const,
			gap: '0.3rem',
		},
		'& .mail-columns': { gridTemplateColumns: '1fr' },
		'& .inbox': {
			borderRight: 0,
			borderBottom: `1px solid ${colors.border}`,
			paddingBottom: 0,
		},
		'& .thread-list': { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' },
		'& .thread-list button': {
			padding: '0.75rem',
			borderLeft: 0,
			borderBottom: '3px solid transparent',
		},
		'& .thread-list button[aria-pressed="true"]': {
			borderBottomColor: colors.primaryText,
		},
		'& .thread-list strong': { fontSize: '0.8rem' },
		'& .preview, & .scope-note': { display: 'none' },
		'& .message-pane': { padding: '1.25rem', minHeight: '405px' },
		'& .choice, & .beyond': { paddingBlock: '3rem' },
		'& .boundary': { padding: '1.5rem' },
		'& .workflow-row': {
			flexDirection: 'column' as const,
			alignItems: 'start',
			gap: '0.65rem',
		},
		'& .workflow-row span[aria-hidden]': { transform: 'rotate(90deg)' },
		'& .beyond-copy': { gap: 0 },
	},
}
