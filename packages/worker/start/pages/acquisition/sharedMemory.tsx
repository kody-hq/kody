/** @jsxImportSource @emotion/react */
import { publicAsset } from '../../public-assets.ts'
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { sharedMemory } from '#universal/acquisition/sharedMemory.ts'
const agents = {
	'Claude Code': {
		task: 'Which project do I call Maple?',
		result: 'Maple is your nickname for the customer portal project.',
	},
	Cursor: {
		task: 'What does Maple refer to?',
		result:
			'Your customer portal project, according to the fact you saved in Kody.',
	},
	Codex: {
		task: 'Remind me which project Maple is.',
		result: 'Maple refers to your customer portal project.',
	},
} as const
type Agent = keyof typeof agents
export function SharedMemoryPage() {
	const [selected, setSelected] = useState<Agent>('Claude Code')
	const example = agents[selected]
	return (
		<div css={memoryCss}>
			<div className="memory-wrap">
				<header className="memory-hero">
					<h1>{sharedMemory.title}</h1>
					<div className="memory-lead">
						<p>
							Give repeatable work a package. Save the leftover facts in memory.
						</p>
						<p>
							Keep task behavior in code, with typed inputs and documented
							defaults. Use memory for facts that don’t have a better home, like
							a project nickname your other agents should recognize.
						</p>
						<SiteLink className="memory-button" href="/onboarding">
							Connect your agents <span aria-hidden="true">↗</span>
						</SiteLink>
					</div>
				</header>

				<section className="memory-demo" aria-label="Shared memory example">
					<div className="memory-record">
						<div className="memory-record-heading">
							<img
								src={publicAsset('/logo-64.webp')}
								width={28}
								height={28}
								alt=""
							/>
							<strong>Your Kody memory</strong>
						</div>
						<div className="memory-paper">
							<span className="memory-paper-label">Project nickname</span>
							<p>
								“Maple” is my nickname for
								<br />
								the customer portal project.
							</p>
						</div>
						<p className="memory-account">
							Available to agents connected to the same Kody account.
						</p>
					</div>
					<div className="memory-agent">
						<div
							className="memory-agent-picker"
							role="group"
							aria-label="Choose an agent for the memory example"
						>
							{(Object.keys(agents) as Agent[]).map((agent) => (
								<button
									key={agent}
									type="button"
									aria-pressed={selected === agent ? 'true' : 'false'}
									onClick={() => {
										setSelected(agent)
									}}
								>
									{agent}
								</button>
							))}
						</div>
						<div
							className="memory-conversation"
							aria-live="polite"
							aria-atomic="true"
						>
							<p className="memory-request">{example.task}</p>
							<div className="memory-retrieval">
								<span aria-hidden="true">↳</span>
								<div>
									<strong>Relevant memory from Kody</strong>
									<p>Maple is the customer portal project.</p>
								</div>
							</div>
							<p className="memory-answer">{example.result}</p>
						</div>
					</div>
				</section>
				<p className="memory-caption">
					Example only, these buttons don’t read or change your saved memories.
				</p>

				<section className="memory-boundaries">
					<div>
						<h2>Choose the right home for context.</h2>
						<p>
							Want every release summary to include source links and put
							breaking changes first? Build that into the release-summary
							package so it happens whenever you run it.
						</p>
						<SiteLink href="/docs/memory">
							Read how Kody memory works ↗
						</SiteLink>
						<p>
							A reply utility can quote the thread automatically. A weather
							utility can have a documented default location. Neither needs an
							agent to remember a separate instruction each time.
						</p>
					</div>
					<dl className="memory-context-list">
						<dt>In package code and documentation</dt>
						<dd>
							Repeatable steps, output rules, typed inputs, and task defaults.
						</dd>
						<dt>In your Kody memory</dt>
						<dd>
							Facts that don’t already belong in a package or another system,
							like a project nickname or how you know someone.
						</dd>
						<dt>In your repository or client</dt>
						<dd>
							Local instructions and conversation history. Connecting Kody
							doesn’t synchronize every chat.
						</dd>
						<dt>In package storage or secrets</dt>
						<dd>
							A workflow’s last processed item belongs in storage. API
							credentials belong in secrets or integrations.
						</dd>
					</dl>
				</section>
			</div>

			<section className="memory-control">
				<div className="memory-wrap memory-control-grid">
					<h2>
						You decide
						<br />
						what sticks.
					</h2>
					<div>
						<p>
							The agent checks related memories before it saves, updates, or
							deletes a fact. You can review and export what’s been saved.
						</p>
						<p>
							Kody finds a few relevant memories when your agent searches or
							runs code with task context. It doesn’t load everything, so a
							saved fact won’t necessarily show up in every response.
						</p>
						<p>
							Shared memory here means your own connected agents. It doesn’t
							automatically share your private context with other people.
						</p>
						<SiteLink href="/docs/agent-guidance">
							Separate shared context from agent instructions ↗
						</SiteLink>
					</div>
				</div>
			</section>

			<div className="memory-wrap">
				<section className="memory-try" id="try-it">
					<div>
						<h2>Save a fact, then try another agent.</h2>
						<ol>
							<li>Connect two agents to your Kody account.</li>
							<li>Give the first agent this prompt.</li>
							<li>
								Ask the second to retrieve the project nickname you saved.
							</li>
						</ol>
						<p>
							Change the fact and verify it again, or delete the test memory
							when you’re done.
						</p>
						<SiteLink href="/onboarding">Set up your Kody account ↗</SiteLink>
					</div>
					<div className="memory-prompt">
						<p>{sharedMemory.prompt}</p>
						<CopyTextButton
							value={sharedMemory.prompt}
							idleLabel="Copy prompt"
							variant="secondary"
						/>
					</div>
				</section>
				<nav className="memory-related" aria-label="Related memory workflows">
					<SiteLink href="/use-cases/mcp-gateway">
						Connect agents through one MCP gateway{' '}
						<span aria-hidden="true">↗</span>
					</SiteLink>
					<SiteLink href="/use-cases/claude-code-custom-tools">
						Carry reusable tools between agents{' '}
						<span aria-hidden="true">↗</span>
					</SiteLink>
					<SiteLink href="/integrations/claude">
						Choose your Claude integration <span aria-hidden="true">↗</span>
					</SiteLink>
				</nav>
			</div>
		</div>
	)
}
const memoryCss = {
	color: 'var(--color-text)',
	background: 'var(--color-background)',
	fontFamily: 'var(--font-family)',
	'& *': { boxSizing: 'border-box' },
	'& h1, & h2, & p, & dl': { margin: 0 },
	'& h1, & h2': { fontFamily: 'var(--font-display)', fontWeight: 600 },
	'& a:focus-visible, & button:focus-visible': {
		outline: '3px solid light-dark(#bb582f, var(--color-field-border))',
		outlineOffset: '5px',
	},
	'& .memory-wrap': { maxWidth: '1180px', margin: '0 auto', padding: '0 36px' },
	'& .memory-hero': {
		display: 'grid',
		gridTemplateColumns: '1.25fr 1fr',
		gap: '64px',
		alignItems: 'center',
		padding: '70px 0 48px',
	},
	'& h1': { fontSize: '54px', lineHeight: 1.08, maxWidth: '650px' },
	'& .memory-lead > p:first-child': {
		fontFamily: 'var(--font-display)',
		fontSize: '25px',
		marginBottom: '14px',
	},
	'& .memory-lead > p:nth-child(2)': {
		fontSize: '17px',
		lineHeight: 1.65,
		color: 'var(--color-text-muted)',
	},
	'& .memory-button': {
		display: 'inline-flex',
		gap: '28px',
		padding: '13px 20px',
		borderRadius: '6px',
		marginTop: '24px',
		background: 'light-dark(#234238, var(--color-primary))',
		color: 'light-dark(#fff, var(--color-on-primary))',
		textDecoration: 'none',
		fontWeight: 600,
	},
	'& .memory-demo': {
		display: 'grid',
		gridTemplateColumns: '0.9fr 1.3fr',
		border: '1px solid light-dark(#c7d1c7, var(--color-border))',
		borderRadius: '12px',
		overflow: 'hidden',
		background: 'light-dark(#f7f8f3, var(--color-surface))',
		color: 'light-dark(#20362d, var(--color-text))',
	},
	'& .memory-record': {
		padding: '30px',
		background: 'light-dark(#e9eedf, var(--color-background))',
		borderRight: '1px solid light-dark(#c7d1c7, var(--color-border))',
	},
	'& .memory-record-heading': {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
		fontSize: '14px',
	},
	'& .memory-paper': {
		margin: '26px 0 20px',
		padding: '23px',
		background: 'light-dark(#fffef5, var(--color-surface))',
		border: '1px solid light-dark(#d4d9c4, var(--color-border))',
		borderRadius: '2px 14px 2px 2px',
		boxShadow: '5px 5px 0 light-dark(#d6ddca, var(--color-border))',
	},
	'& .memory-paper-label': {
		display: 'block',
		color: 'light-dark(#667052, var(--color-text-muted))',
		fontSize: '12px',
		paddingBottom: '14px',
		borderBottom: '1px solid light-dark(#dce0cf, var(--color-border))',
	},
	'& .memory-paper p': {
		fontFamily: 'var(--font-display)',
		fontSize: '25px',
		lineHeight: 1.45,
		padding: '20px 0',
	},
	'& .memory-account': {
		fontSize: '13px',
		lineHeight: 1.6,
		maxWidth: '300px',
		color: 'light-dark(#596b53, var(--color-text-muted))',
	},
	'& .memory-agent': { minWidth: 0 },
	'& .memory-agent-picker': {
		display: 'flex',
		padding: '14px',
		gap: '6px',
		borderBottom: '1px solid light-dark(#d8dfd2, var(--color-border))',
	},
	'& .memory-agent-picker button': {
		flex: 1,
		padding: '10px 8px',
		border: '1px solid transparent',
		borderRadius: '5px',
		font: 'inherit',
		fontSize: '14px',
		color: 'light-dark(#53674f, var(--color-text-muted))',
		background: 'transparent',
		cursor: 'pointer',
	},
	'& .memory-agent-picker button[aria-pressed="true"]': {
		background: 'light-dark(#234238, var(--color-primary))',
		color: 'light-dark(#fff, var(--color-on-primary))',
	},
	'& .memory-agent-picker button:hover': {
		borderColor: 'light-dark(#8da381, var(--color-border))',
	},
	'& .memory-conversation': { padding: '28px', minHeight: '310px' },
	'& .memory-request': {
		padding: '14px 17px',
		background: 'light-dark(#e9ede3, var(--color-background))',
		borderRadius: '8px',
		fontSize: '15px',
		lineHeight: 1.6,
	},
	'& .memory-retrieval': {
		display: 'flex',
		gap: '12px',
		padding: '23px 0',
		color: 'light-dark(#58704b, var(--color-text-muted))',
	},
	'& .memory-retrieval > span': { fontSize: '25px' },
	'& .memory-retrieval strong': { fontSize: '12px', fontWeight: 600 },
	'& .memory-retrieval p': {
		fontSize: '13px',
		lineHeight: 1.6,
		marginTop: '5px',
	},
	'& .memory-answer': { fontSize: '15px', lineHeight: 1.65 },
	'& .memory-caption': {
		fontSize: '12px',
		color: 'var(--color-text-muted)',
		marginTop: '12px',
	},
	'& .memory-boundaries': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.1fr',
		gap: '95px',
		padding: '90px 0',
	},
	'& h2': { fontSize: '38px', lineHeight: 1.15 },
	'& .memory-boundaries p, & .memory-try > div > p': {
		fontSize: '17px',
		lineHeight: 1.7,
		margin: '22px 0',
		color: 'var(--color-text-muted)',
	},
	'& .memory-boundaries a, & .memory-try a': { fontSize: '14px' },
	'& .memory-context-list dt': {
		fontWeight: 600,
		borderTop: '1px solid var(--color-border)',
		paddingTop: '18px',
	},
	'& .memory-context-list dd': {
		margin: '8px 0 22px',
		fontSize: '15px',
		lineHeight: 1.65,
		color: 'var(--color-text-muted)',
	},
	'& .memory-control': {
		background: 'light-dark(#234238, var(--color-surface))',
		color: 'light-dark(#f3f5e9, var(--color-text))',
		padding: '65px 0',
	},
	'& .memory-control-grid': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.1fr',
		gap: '95px',
	},
	'& .memory-control p': {
		color: 'light-dark(#d0decb, var(--color-text))',
		lineHeight: 1.7,
		marginBottom: '18px',
		fontSize: '16px',
	},
	'& .memory-control a': { fontSize: '14px' },
	'& .memory-try': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.1fr',
		gap: '95px',
		padding: '85px 0 65px',
		scrollMarginTop: '100px',
	},
	'& .memory-try ol': {
		paddingLeft: '22px',
		lineHeight: 1.7,
		marginTop: '24px',
	},
	'& .memory-try li': { padding: '5px 0' },
	'& .memory-prompt': {
		alignSelf: 'center',
		borderLeft: '3px solid light-dark(#829766, var(--color-border))',
		padding: '6px 0 6px 28px',
	},
	'& .memory-prompt p': {
		fontSize: '19px',
		lineHeight: 1.7,
		marginBottom: '24px',
	},
	'& .memory-related': {
		borderTop: '1px solid var(--color-border)',
		padding: '20px 0 50px',
		display: 'grid',
		gridTemplateColumns: '1fr 1fr 1fr',
		gap: '30px',
	},
	'& .memory-related a': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '18px',
		padding: '15px 0',
		fontSize: '15px',
		lineHeight: 1.5,
	},
	'@media (max-width: 850px)': {
		'& .memory-hero': { gap: '35px' },
		'& h1': { fontSize: '44px' },
		'& .memory-boundaries, & .memory-control-grid, & .memory-try': {
			gap: '45px',
		},
		'& .memory-record': { padding: '22px' },
		'& .memory-paper': { padding: '18px' },
		'& .memory-paper p': { fontSize: '22px' },
	},
	'@media (max-width: 640px)': {
		'& .memory-wrap': { padding: '0 22px' },
		'& .memory-hero': {
			gridTemplateColumns: '1fr',
			padding: '38px 0 30px',
			gap: '24px',
		},
		'& h1': { fontSize: '38px', lineHeight: 1.12 },
		'& .memory-lead > p:first-child': { fontSize: '22px', marginBottom: '8px' },
		'& .memory-lead > p:nth-child(2)': { fontSize: '16px' },
		'& .memory-demo': { gridTemplateColumns: '1fr' },
		'& .memory-record': {
			borderRight: 0,
			borderBottom: '1px solid light-dark(#c7d1c7, var(--color-border))',
			padding: '20px',
		},
		'& .memory-paper': { margin: '18px 0' },
		'& .memory-paper p': { padding: '14px 0' },
		'& .memory-conversation': { padding: '22px', minHeight: '320px' },
		'& .memory-agent-picker': { padding: '10px', gap: '3px' },
		'& .memory-agent-picker button': { fontSize: '13px', padding: '11px 6px' },
		'& .memory-boundaries, & .memory-control-grid, & .memory-try': {
			gridTemplateColumns: '1fr',
			gap: '30px',
		},
		'& .memory-boundaries, & .memory-try': { padding: '55px 0' },
		'& h2': { fontSize: '32px' },
		'& .memory-control': { padding: '48px 0' },
		'& .memory-related': { gridTemplateColumns: '1fr', gap: 0 },
		'& .memory-related a': { padding: '17px 0' },
		'& .memory-prompt': { paddingLeft: '20px' },
		'& .memory-prompt p': { fontSize: '17px' },
	},
} as const
