/** @jsxImportSource @emotion/react */
import { publicAsset } from '../../public-assets.ts'
import { SiteLink } from '../../components/site-link.tsx'
import { acquisitionPageMeta } from '#universal/acquisition/metadata.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
const everyday = [
	{
		key: 'gmail',
		title: 'Get through your inbox.',
		detail:
			'Sort messages, prepare replies, and keep the workflow for tomorrow.',
		symbol: '↗',
		tone: 'mail',
	},
	{
		key: 'slack',
		title: 'Keep your team in the loop.',
		detail:
			'Turn updates from your services into a Slack digest with source links.',
		symbol: '#',
		tone: 'slack',
	},
	{
		key: 'scheduledWorkflows',
		title: 'Let the next run happen.',
		detail:
			'Put the code you built on a schedule, with its progress saved between runs.',
		symbol: '↻',
		tone: 'schedule',
	},
] as const
const tools = [
	{
		key: 'customTools',
		title: 'Custom tools',
		detail: 'Build it with Claude Code. Use it again from any connected agent.',
	},
	{
		key: 'sharedMemory',
		title: 'Shared memory',
		detail:
			'Carry useful facts between agents when they don’t have a better home.',
	},
	{
		key: 'mcpGateway',
		title: 'MCP gateway',
		detail: 'Bring your tools and connected accounts together.',
	},
	{
		key: 'claudeIntegrations',
		title: 'Claude integrations',
		detail: 'Give Claude access to the services and workflows you use.',
	},
] as const
export function UseCasesPage() {
	return (
		<article css={styles}>
			<header className="opening">
				<h1>{acquisitionPageMeta.useCases.title}</h1>
				<div>
					<p>
						Start with something you do all the time. Give your agent the tools
						to do it, then keep what works.
					</p>
					<nav aria-label="Browse use cases">
						<SiteLink href="#everyday">Everyday workflows ↓</SiteLink>
						<SiteLink href="#agent-tools">Tools for your agents ↓</SiteLink>
					</nav>
				</div>
			</header>
			<SiteLink className="feature" href={acquisitionPageMeta.automation.path}>
				<div className="feature-copy">
					<h2>
						That thing you do every week?
						<br />
						Build it once.
					</h2>
					<p>
						Let your agent turn the steps into code. Kody keeps the connections,
						progress, and schedule together.
					</p>
					<span className="feature-link">
						Explore AI workflow automation <span aria-hidden="true">↗</span>
					</span>
				</div>
				<div
					className="workflow"
					aria-label="Example workflow: collect GitHub releases, prepare a digest, and deliver it to Slack every Friday"
				>
					<div className="workflow-source">
						<span className="node-icon" aria-hidden="true">
							⌘
						</span>
						<div>
							<strong>GitHub releases</strong>
							<span>From the repositories you choose</span>
						</div>
					</div>
					<div className="connector" aria-hidden="true">
						↓
					</div>
					<div className="saved-tool">
						<img
							src={publicAsset('/logo-64.webp')}
							width="36"
							height="36"
							alt=""
						/>
						<div>
							<strong>Release digest</strong>
							<span>A saved Kody package</span>
						</div>
						<span className="code-mark" aria-hidden="true">
							{'{ }'}
						</span>
					</div>
					<div className="connector" aria-hidden="true">
						↓
					</div>
					<div className="workflow-output">
						<span className="node-icon" aria-hidden="true">
							#
						</span>
						<div>
							<strong>Slack update</strong>
							<span>Every Friday, with source links</span>
						</div>
					</div>
					<small>Example workflow</small>
				</div>
			</SiteLink>
			<section id="everyday" className="everyday">
				<h2>Take something off your list.</h2>
				<div className="tasks">
					{everyday.map((item) => (
						<SiteLink
							key={item.key}
							href={acquisitionPageMeta[item.key].path}
							className={item.tone}
						>
							<span className="task-icon" aria-hidden="true">
								{item.symbol}
							</span>
							<h3>{item.title}</h3>
							<p>{item.detail}</p>
							<span className="task-link">
								{item.key === 'gmail'
									? 'Gmail automation'
									: item.key === 'slack'
										? 'Slack automation'
										: 'Scheduled workflows'}{' '}
								<span aria-hidden="true">↗</span>
							</span>
						</SiteLink>
					))}
				</div>
			</section>
			<section id="agent-tools" className="agent-tools">
				<div className="tools-heading">
					<img
						src={publicAsset('/logo-64.webp')}
						width="56"
						height="56"
						alt=""
					/>
					<h2>
						Your next agent
						<br />
						gets a head start.
					</h2>
					<p>
						The tools, accounts, and context you save in Kody are ready for your
						other connected agents.
					</p>
				</div>
				<div className="tool-list">
					{tools.map((item) => (
						<SiteLink key={item.key} href={acquisitionPageMeta[item.key].path}>
							<div>
								<h3>{item.title}</h3>
								<p>{item.detail}</p>
							</div>
							<span aria-hidden="true">↗</span>
						</SiteLink>
					))}
				</div>
			</section>
			<section className="comparisons">
				<h2>Considering a switch?</h2>
				<div>
					<SiteLink href={acquisitionPageMeta.n8nAlternatives.path}>
						Kody and n8n <span aria-hidden="true">↗</span>
					</SiteLink>
					<SiteLink href={acquisitionPageMeta.composioAlternatives.path}>
						Kody and Composio <span aria-hidden="true">↗</span>
					</SiteLink>
				</div>
			</section>
		</article>
	)
}
const styles = {
	maxWidth: '74rem',
	margin: '0 auto',
	padding: '4.5rem 1.5rem 5rem',
	color: colors.text,
	'& h1, & h2, & h3': {
		fontFamily: typography.fontFamilyDisplay,
		fontWeight: 500,
		margin: 0,
	},
	'& a': { color: 'inherit', textDecoration: 'none' },
	'& a:focus-visible': {
		outline: `3px solid ${colors.primaryText}`,
		outlineOffset: '5px',
	},
	'& p': { lineHeight: 1.65, color: colors.textMuted },
	'& .opening': {
		display: 'grid',
		gridTemplateColumns: '1.15fr 1fr',
		gap: '5rem',
		alignItems: 'end',
		marginBottom: '3.5rem',
	},
	'& h1': { fontSize: '4rem', lineHeight: 1.06, maxWidth: '16ch' },
	'& .opening p': {
		fontSize: '1.15rem',
		margin: '0 0 1.5rem',
		maxWidth: '35ch',
	},
	'& nav': {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '1rem 1.5rem',
		fontSize: '.85rem',
	},
	'& nav a': { textDecoration: 'underline', textUnderlineOffset: '5px' },
	'& .feature': {
		display: 'grid',
		gridTemplateColumns: '1.15fr 1fr',
		background: 'light-dark(#e1e9d9, #202d25)',
		borderRadius: '12px',
		overflow: 'hidden',
	},
	'& .feature-copy': {
		padding: '3rem',
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'start',
	},
	'& .feature h2': { fontSize: '2.6rem', lineHeight: 1.15 },
	'& .feature p': { maxWidth: '34ch', margin: '1.5rem 0 2.5rem' },
	'& .feature-link': {
		marginTop: 'auto',
		display: 'flex',
		gap: '1.5rem',
		fontWeight: 600,
	},
	'& .workflow': {
		padding: '2rem 2.5rem',
		background: 'light-dark(#d3dfc8, #19241e)',
		display: 'flex',
		flexDirection: 'column',
		justifyContent: 'center',
	},
	'& .workflow-source, & .workflow-output, & .saved-tool': {
		display: 'flex',
		gap: '1rem',
		alignItems: 'center',
	},
	'& .workflow strong, & .workflow span span': { display: 'block' },
	'& .workflow div > div > span': {
		display: 'block',
		fontSize: '.8rem',
		color: colors.textMuted,
		marginTop: '.3rem',
	},
	'& .node-icon': {
		fontFamily: typography.fontFamilyMono,
		fontSize: '1.5rem',
		width: '36px',
		textAlign: 'center',
	},
	'& .connector': { margin: '.65rem 0 .65rem 1rem', color: colors.textMuted },
	'& .saved-tool': {
		background: colors.surface,
		border: `1px solid ${colors.border}`,
		padding: '1.1rem',
		borderRadius: '8px',
		marginLeft: '-1.1rem',
	},
	'& .code-mark': {
		marginLeft: 'auto',
		fontFamily: typography.fontFamilyMono,
		color: colors.primaryText,
	},
	'& .workflow small': {
		fontSize: '.7rem',
		color: colors.textMuted,
		marginTop: '1.5rem',
	},
	'& .everyday': { padding: '4.5rem 0' },
	'& .everyday > h2': { fontSize: '2rem', marginBottom: '2rem' },
	'& .tasks': {
		display: 'grid',
		gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
		gap: '2.5rem',
	},
	'& .tasks > a': {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'start',
		borderTop: `1px solid ${colors.border}`,
		paddingTop: '1.5rem',
	},
	'& .task-icon': {
		width: '48px',
		height: '48px',
		display: 'grid',
		placeItems: 'center',
		fontSize: '1.8rem',
		borderRadius: '12px',
		marginBottom: '1.5rem',
	},
	'& .mail .task-icon': {
		background: 'light-dark(#f3dfcb, #3e2a1c)',
		color: 'light-dark(#7e441d, #efb782)',
	},
	'& .slack .task-icon': {
		background: 'light-dark(#dde2f0, #262d42)',
		color: 'light-dark(#424f7b, #b4c0ee)',
	},
	'& .schedule .task-icon': {
		background: 'light-dark(#e2e9cb, #2b341d)',
		color: 'light-dark(#526625, #c4d894)',
	},
	'& h3': { fontSize: '1.35rem', lineHeight: 1.3 },
	'& .tasks p': { margin: '1rem 0 1.5rem' },
	'& .task-link': {
		marginTop: 'auto',
		fontSize: '.85rem',
		textDecoration: 'underline',
		textUnderlineOffset: '5px',
	},
	'& .agent-tools': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.3fr',
		gap: '5rem',
		padding: '3rem 0 4rem',
		borderTop: `1px solid ${colors.border}`,
	},
	'& .tools-heading h2': {
		fontSize: '2.5rem',
		lineHeight: 1.15,
		marginTop: '1.5rem',
	},
	'& .tools-heading p': { maxWidth: '30ch' },
	'& .tool-list a': {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: '1.5rem',
		padding: '1.5rem 0',
		borderBottom: `1px solid ${colors.border}`,
	},
	'& .tool-list a:first-child': { paddingTop: 0 },
	'& .tool-list p': {
		margin: '.5rem 0 0',
		maxWidth: '38ch',
		fontSize: '.95rem',
	},
	'& .tool-list a > span': { fontSize: '1.5rem', color: colors.primaryText },
	'& .comparisons': {
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'space-between',
		gap: '2rem',
		padding: '2rem 0',
		borderTop: `1px solid ${colors.border}`,
	},
	'& .comparisons h2': { fontSize: '1.2rem', color: colors.textMuted },
	'& .comparisons > div': { display: 'flex', gap: '2rem' },
	'@media (hover: hover) and (pointer: fine)': {
		'& a:hover h3, & nav a:hover, & .comparisons a:hover, & .feature:hover .feature-link':
			{ color: colors.primaryText },
	},
	'@media (max-width: 800px)': {
		'& .opening': { gap: '2rem' },
		'& h1': { fontSize: '3rem' },
		'& .feature-copy': { padding: '2rem' },
		'& .feature h2': { fontSize: '2rem' },
		'& .workflow': { padding: '2rem' },
		'& .tasks': { gap: '1.5rem' },
		'& .agent-tools': { gap: '2.5rem' },
	},
	'@media (max-width: 600px)': {
		padding: '2.5rem 1.25rem',
		'& .opening, & .feature, & .tasks, & .agent-tools': {
			gridTemplateColumns: '1fr',
		},
		'& h1': { fontSize: '2.8rem' },
		'& .opening': { gap: '1.5rem', marginBottom: '2rem' },
		'& .opening p': { fontSize: '1rem' },
		'& .feature-copy': { padding: '1.75rem' },
		'& .feature p': { margin: '1rem 0 1.5rem' },
		'& .workflow': { padding: '1.75rem 2rem' },
		'& .everyday': { padding: '3rem 0' },
		'& .tasks': { gap: '2rem' },
		'& .task-icon': { marginBottom: '1rem' },
		'& .tools-heading h2': { fontSize: '2rem' },
		'& .comparisons, & .comparisons > div': {
			flexDirection: 'column',
			alignItems: 'start',
			gap: '1.25rem',
		},
	},
} as const
