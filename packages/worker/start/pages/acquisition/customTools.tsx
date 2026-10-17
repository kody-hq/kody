/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { customTools } from '#universal/acquisition/customTools.ts'
const cases = {
	release: {
		input: 'acme/website',
		output:
			'{\n  "repository": "acme/website",\n  "status": "released",\n  "version": "v1.4.0",\n  "url": "https://github.com/acme/website/releases/tag/v1.4.0"\n}',
	},
	empty: {
		input: 'acme/new-project',
		output:
			'{\n  "repository": "acme/new-project",\n  "status": "no_releases",\n  "version": null,\n  "url": null\n}',
	},
	access: {
		input: 'acme/private-project',
		output:
			'{\n  "repository": "acme/private-project",\n  "status": "access_unavailable",\n  "version": null,\n  "url": null\n}',
	},
} as const
export function CustomToolsPage() {
	const [selected, setSelected] = useState<keyof typeof cases>('release')
	const [caller, setCaller] = useState<'Claude Code' | 'Codex'>('Claude Code')
	const example = cases[selected]
	return (
		<div css={toolCss}>
			<div className="tool-wrap">
				<header className="tool-hero">
					<div>
						<h1>{customTools.title}</h1>
						<p className="tool-lead">
							Got a tool working in Claude Code? Keep it.
						</p>
						<p>
							Build a tool with Claude Code and save it as a Kody package, then
							use it again in your next session or from another connected agent.
						</p>
						<div className="tool-actions">
							<SiteLink className="tool-button" href="/onboarding">
								Connect Claude Code ↗
							</SiteLink>
							<SiteLink href="#workbench">Explore a saved tool ↓</SiteLink>
						</div>
					</div>
					<div
						className="tool-sketch"
						aria-label="A conversation becomes a reusable package"
					>
						<p className="tool-request">
							“Check the latest release for these repositories.”
						</p>
						<div className="tool-connector" aria-hidden="true">
							↓
						</div>
						<div className="tool-package">
							<span>release-lookup</span>
							<code>repositories → release results</code>
						</div>
						<div className="tool-connector" aria-hidden="true">
							↓
						</div>
						<div className="tool-callers">
							<span>Claude Code</span>
							<span>Codex</span>
							<span>Other connected agents</span>
						</div>
						<p className="tool-caption">
							Your connected agents can all use the same saved tool.
						</p>
					</div>
				</header>
				<section
					id="workbench"
					className="tool-workbench"
					aria-labelledby="workbench-heading"
				>
					<div className="tool-workbench-heading">
						<h2 id="workbench-heading">
							Give the next agent
							<br />a tool it can call.
						</h2>
						<p>
							Try the sample lookup below. It uses example data and won’t call
							GitHub or create a package.
						</p>
					</div>
					<div className="tool-editor">
						<div className="tool-editor-bar">
							<span>release-lookup</span>
							<span>Reads data without changing it</span>
						</div>
						<div className="tool-editor-grid">
							<div className="tool-input">
								<h3>Input</h3>
								<div
									className="tool-options"
									role="group"
									aria-label="Choose an example repository"
								>
									{(['release', 'empty', 'access'] as const).map((key) => (
										<button
											key={key}
											type="button"
											aria-pressed={selected === key ? 'true' : 'false'}
											onClick={() => {
												setSelected(key)
											}}
										>
											{cases[key].input}
										</button>
									))}
								</div>
								<h3>Caller</h3>
								<div
									className="tool-call-options"
									role="group"
									aria-label="Choose a calling agent"
								>
									{(['Claude Code', 'Codex'] as const).map((agent) => (
										<button
											key={agent}
											type="button"
											aria-pressed={caller === agent ? 'true' : 'false'}
											onClick={() => {
												setCaller(agent)
											}}
										>
											{agent}
										</button>
									))}
								</div>
								<p className="tool-call-message">
									{caller === 'Claude Code'
										? 'Find my saved release lookup and check this repository.'
										: 'Use my release lookup package for this repository. Keep the same output format.'}
								</p>
							</div>
							<div className="tool-output" aria-live="polite">
								<h3>{caller} receives</h3>
								<pre>
									<code>{example.output}</code>
								</pre>
								<p>
									{selected === 'access'
										? 'You couldn’t access the repository, so you don’t know whether it has releases.'
										: selected === 'empty'
											? 'The lookup worked, this repository just doesn’t have any releases.'
											: 'The next agent gets the same result format, so it can use the tool without rebuilding it.'}
								</p>
							</div>
						</div>
					</div>
				</section>
				<section className="tool-contract">
					<div>
						<h2>Give your agent code it can run again.</h2>
						<p>
							Keep your agent instructions for choosing the tool. Save the
							repeatable work in a package and explain what the tool accepts and
							what it returns.
						</p>
						<SiteLink href="/docs/package-authoring">
							Read the package-authoring guide ↗
						</SiteLink>
					</div>
					<dl>
						<div>
							<dt>Inputs</dt>
							<dd>
								Decide which repositories to accept and how to handle an empty
								list.
							</dd>
						</div>
						<div>
							<dt>Results</dt>
							<dd>
								Return the repository, version, release URL, and publication
								time. Separate missing access from no releases.
							</dd>
						</div>
						<div>
							<dt>State and access</dt>
							<dd>
								Keep credentials in account integrations or secrets. Keep track
								of the last completed step in package storage.
							</dd>
						</div>
					</dl>
				</section>
				<section className="tool-lifecycle">
					<h2>Test it in a fresh conversation.</h2>
					<ol>
						<li>
							<h3>Get one task working</h3>
							<p>
								Connect Claude Code, load the authoring guide, and explore a
								small read-only task through search and execute.
							</p>
						</li>
						<li>
							<h3>Save and publish</h3>
							<p>
								Describe what goes in and what comes back. Check pagination,
								prereleases, and unavailable services before depending on it.
							</p>
						</li>
						<li>
							<h3>Try a fresh conversation</h3>
							<p>
								Find and call the package from a second connected agent. Review
								and publish later changes, using owner approval if the package
								is locked.
							</p>
						</li>
					</ol>
					<p className="tool-runtime">
						Kody has runtime and usage limits. A saved package doesn’t make
						every local binary or long-running server portable.{' '}
						<SiteLink href="/docs/package-lifecycle">
							See the package lifecycle ↗
						</SiteLink>
					</p>
				</section>
				<section id="try-it" className="tool-start">
					<div>
						<h2>
							Build your first
							<br />
							reusable tool.
						</h2>
						<p>Connect your agent, then give it this starting prompt.</p>
						<SiteLink className="tool-button" href="/onboarding">
							Get started with Kody ↗
						</SiteLink>
					</div>
					<div className="tool-prompt">
						<p>{customTools.prompt}</p>
						<CopyTextButton
							value={customTools.prompt}
							idleLabel="Copy prompt"
						/>
					</div>
				</section>
				<nav className="tool-next" aria-label="Custom tool resources">
					<SiteLink href="/docs/connect-your-agent">
						Connect your agent ↗
					</SiteLink>
					<SiteLink href="/docs/search-and-execute">
						Search and execute ↗
					</SiteLink>
					<SiteLink href="/use-cases/scheduled-workflows">
						Schedule the working tool ↗
					</SiteLink>
					<SiteLink href="/use-cases/mcp-gateway">
						Connect more tools through MCP ↗
					</SiteLink>
					<SiteLink href="/compare/n8n-alternatives">
						Compare n8n alternatives ↗
					</SiteLink>
				</nav>
			</div>
		</div>
	)
}
const toolCss = {
	background: 'light-dark(#f5f3ed, var(--color-surface))',
	color: 'light-dark(#222e2b, var(--color-text))',
	fontFamily: 'var(--font-family)',
	lineHeight: '1.6',
	'& *': { boxSizing: 'border-box' },
	'& .tool-wrap': {
		maxWidth: '1200px',
		margin: 'auto',
		padding: '64px 40px 48px',
	},
	'& h1, & h2, & h3, & p': { margin: 0 },
	'& h1, & h2, & h3': { fontFamily: 'var(--font-display)' },
	'& h1': {
		fontSize: '56px',
		lineHeight: '1.07',
		maxWidth: '670px',
		fontWeight: 600,
	},
	'& h2': { fontSize: '38px', lineHeight: '1.15', fontWeight: 600 },
	'& h3': { fontSize: '18px' },
	'& button, & a': { WebkitTapHighlightColor: 'transparent' },
	'& a:focus-visible, & button:focus-visible': {
		outline: '3px solid light-dark(#b54b27, var(--color-field-border))',
		outlineOffset: '5px',
	},
	'& .tool-hero': {
		display: 'grid',
		gridTemplateColumns: '1.25fr 1fr',
		gap: '64px',
		alignItems: 'center',
		paddingBottom: '90px',
	},
	'& .tool-lead': {
		fontSize: '23px',
		lineHeight: '1.45',
		margin: '28px 0 16px',
		maxWidth: '470px',
	},
	'& .tool-hero p:not(.tool-lead)': { maxWidth: '490px' },
	'& .tool-actions': {
		display: 'flex',
		gap: '20px',
		flexWrap: 'wrap',
		alignItems: 'center',
		marginTop: '30px',
	},
	'& .tool-button': {
		display: 'inline-flex',
		background: 'light-dark(#244638, var(--color-primary))',
		color: 'light-dark(#fff, var(--color-on-primary))',
		textDecoration: 'none',
		padding: '13px 20px',
		borderRadius: '5px',
		fontWeight: 600,
	},
	'& .tool-sketch': { paddingTop: '30px' },
	'& .tool-request': {
		borderLeft: '3px solid light-dark(#bf633f, var(--color-border))',
		padding: '12px 20px',
		fontSize: '21px',
	},
	'& .tool-connector': {
		textAlign: 'center',
		fontSize: '29px',
		padding: '8px',
	},
	'& .tool-package': {
		background: 'light-dark(#e0e7cc, var(--color-background))',
		border: '1px solid light-dark(#abbc96, var(--color-border))',
		padding: '26px',
		display: 'grid',
		gap: '12px',
		borderRadius: '5px',
	},
	'& .tool-package span': { fontSize: '24px', fontWeight: 600 },
	'& code': { fontFamily: 'var(--font-mono, monospace)', fontSize: '13px' },
	'& .tool-callers': { display: 'flex', gap: '8px', flexWrap: 'wrap' },
	'& .tool-callers span': {
		padding: '8px 12px',
		border: '1px solid light-dark(#c8ccc0, var(--color-border))',
		borderRadius: '4px',
		fontSize: '13px',
	},
	'& .tool-caption': {
		fontSize: '13px',
		color: 'light-dark(#58655b, var(--color-text-muted))',
		marginTop: '14px',
	},
	'& .tool-workbench': { scrollMarginTop: '40px' },
	'& .tool-workbench-heading': {
		display: 'flex',
		alignItems: 'end',
		justifyContent: 'space-between',
		gap: '40px',
		marginBottom: '30px',
	},
	'& .tool-workbench-heading p': {
		maxWidth: '370px',
		fontSize: '14px',
		color: 'light-dark(#596258, var(--color-text-muted))',
	},
	'& .tool-editor': {
		background: 'light-dark(#202d2a, var(--color-surface))',
		color: 'light-dark(#f1f4e9, var(--color-text))',
		borderRadius: '8px',
		overflow: 'hidden',
	},
	'& .tool-editor-bar': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '15px',
		padding: '17px 26px',
		borderBottom: '1px solid light-dark(#46534c, var(--color-border))',
		fontSize: '13px',
	},
	'& .tool-editor-bar span:first-child': {
		color: 'light-dark(#d3e990, var(--color-text))',
		fontFamily: 'monospace',
	},
	'& .tool-editor-grid': {
		display: 'grid',
		gridTemplateColumns: '0.8fr 1.2fr',
	},
	'& .tool-input': {
		padding: '30px',
		borderRight: '1px solid light-dark(#46534c, var(--color-border))',
	},
	'& .tool-options': { display: 'grid', gap: '7px', margin: '13px 0 30px' },
	'& .tool-editor button': {
		font: 'inherit',
		fontSize: '13px',
		color: 'light-dark(#eff3e9, var(--color-text))',
		background: 'transparent',
		padding: '10px 12px',
		border: '1px solid light-dark(#718074, var(--color-border))',
		borderRadius: '4px',
		cursor: 'pointer',
		textAlign: 'left',
	},
	'& .tool-editor button[aria-pressed="true"]': {
		background: 'light-dark(#d3e990, var(--color-primary))',
		color: 'light-dark(#1d3025, var(--color-on-primary))',
		borderColor: 'light-dark(#d3e990, var(--color-border))',
	},
	'& .tool-call-options': {
		display: 'flex',
		gap: '8px',
		marginTop: '12px',
		flexWrap: 'wrap',
	},
	'& .tool-call-message': {
		marginTop: '18px',
		fontSize: '13px',
		color: 'light-dark(#c3cfc3, var(--color-text))',
	},
	'& .tool-output': { padding: '30px', minWidth: 0 },
	'& .tool-output pre': {
		margin: '26px 0',
		whiteSpace: 'pre-wrap',
		overflowWrap: 'anywhere',
		lineHeight: '1.9',
		color: 'light-dark(#d3e990, var(--color-text))',
		minHeight: '180px',
	},
	'& .tool-output p': {
		fontSize: '14px',
		color: 'light-dark(#c3cfc3, var(--color-text))',
	},
	'& .tool-contract': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '80px',
		padding: '85px 0',
		borderBottom: '1px solid light-dark(#cbd0c3, var(--color-border))',
	},
	'& .tool-contract p': { margin: '24px 0', maxWidth: '460px' },
	'& dl': { margin: 0 },
	'& dl > div': {
		padding: '17px 0',
		borderTop: '1px solid light-dark(#cbd0c3, var(--color-border))',
	},
	'& dt': { fontWeight: 700, fontSize: '16px' },
	'& dd': {
		margin: '7px 0 0',
		color: 'light-dark(#4b594f, var(--color-text-muted))',
		fontSize: '15px',
	},
	'& .tool-lifecycle': { padding: '65px 0' },
	'& .tool-lifecycle ol': {
		display: 'grid',
		gridTemplateColumns: 'repeat(3, 1fr)',
		gap: '36px',
		padding: 0,
		listStyle: 'none',
		margin: '35px 0',
	},
	'& .tool-lifecycle li': {
		borderTop: '3px solid light-dark(#8b9c73, var(--color-border))',
		paddingTop: '20px',
	},
	'& .tool-lifecycle li p': { marginTop: '12px', fontSize: '15px' },
	'& .tool-runtime': {
		maxWidth: '760px',
		fontSize: '14px',
		color: 'light-dark(#596258, var(--color-text-muted))',
	},
	'& .tool-start': {
		display: 'grid',
		gridTemplateColumns: '0.8fr 1.2fr',
		gap: '50px',
		background: 'light-dark(#e0e7cc, var(--color-background))',
		padding: '45px',
		borderRadius: '6px',
		scrollMarginTop: '40px',
	},
	'& .tool-start p': { margin: '20px 0' },
	'& .tool-prompt': {
		borderLeft: '1px solid light-dark(#a5b28f, var(--color-border))',
		paddingLeft: '35px',
	},
	'& .tool-prompt p': { marginTop: 0 },
	'& .tool-next': {
		display: 'flex',
		gap: '20px 30px',
		flexWrap: 'wrap',
		paddingTop: '36px',
		fontSize: '14px',
	},
	'@media (max-width: 800px)': {
		'& .tool-wrap': { padding: '40px 22px' },
		'& h1': { fontSize: '40px' },
		'& h2': { fontSize: '30px' },
		'& .tool-hero, & .tool-contract, & .tool-start': {
			gridTemplateColumns: '1fr',
			gap: '30px',
		},
		'& .tool-hero': { paddingBottom: '50px' },
		'& .tool-sketch': { maxWidth: '480px', paddingTop: 0 },
		'& .tool-workbench-heading': { display: 'block' },
		'& .tool-workbench-heading p': { marginTop: '20px' },
		'& .tool-editor-grid': { gridTemplateColumns: '1fr' },
		'& .tool-input': {
			borderRight: 0,
			borderBottom: '1px solid light-dark(#46534c, var(--color-border))',
			padding: '23px',
		},
		'& .tool-output': { padding: '23px' },
		'& .tool-contract': { padding: '50px 0' },
		'& .tool-lifecycle ol': { gridTemplateColumns: '1fr', gap: '24px' },
		'& .tool-start': { padding: '27px' },
		'& .tool-prompt': {
			borderLeft: 0,
			borderTop: '1px solid light-dark(#a5b28f, var(--color-border))',
			paddingLeft: 0,
			paddingTop: '25px',
		},
	},
} as const
