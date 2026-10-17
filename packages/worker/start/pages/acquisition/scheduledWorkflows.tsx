/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { CopyTextButton } from '../../components/copy-text-button.tsx'
import { scheduledWorkflows as page } from '#universal/acquisition/scheduledWorkflows.ts'
import { routes } from '#universal/routes.ts'
import { colors, typography } from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
const runs = [
	{
		label: 'Report ready',
		time: 'Friday · 08:00',
		output: 'weekly-report.md',
		message: 'Sources collected. Report written. Checkpoint saved.',
		steps: [
			'Read the reporting window',
			'Collect connected sources',
			'Write the report',
			'Save the checkpoint',
		],
	},
	{
		label: 'No changes',
		time: 'Previous Friday · 08:00',
		output: 'No new records',
		message:
			'The job completed. Nothing changed in the reporting window, so there is no new report.',
		steps: [
			'Read the reporting window',
			'Collect connected sources',
			'Confirm no new records',
			'Save the checkpoint',
		],
	},
	{
		label: 'Source unavailable',
		time: 'Earlier Friday · 08:00',
		output: 'Report not written',
		message:
			'A source could not be read. Keep the previous checkpoint so a later run can cover the missing window.',
		steps: [
			'Read the reporting window',
			'Source unavailable',
			'Keep previous checkpoint',
			'Inspect before running again',
		],
	},
]
export function ScheduledWorkflowsPage() {
	const [selected, setSelected] = useState(0)
	const [cadence, setCadence] = useState<'weekly' | 'daily'>('weekly')
	const run = runs[selected]!
	return (
		<article css={styles}>
			<header className="opening">
				<div>
					<h1>{page.title}</h1>
					<p className="lead">
						Get the report working, then give it a schedule. Kody runs the saved
						code and keeps its progress with the package.
					</p>
					<SiteLink href={routes.onboarding.href()} css={getPillButtonCss()}>
						Build your first scheduled job
					</SiteLink>
				</div>
				<div className="calendar" aria-label="Example weekly job schedule">
					<div className="calendar-top">
						<span>weekly-report</span>
						<span>America/Denver</span>
					</div>
					<div className="week">
						{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
							<div key={index} className={index === 4 ? 'due' : ''}>
								<span>{day}</span>
								<strong>{index + 5}</strong>
								{index === 4 ? <small>08:00</small> : null}
							</div>
						))}
					</div>
					<div className="calendar-bottom">
						<span className="dot" />
						Friday arrives. Your package runs.
					</div>
				</div>
			</header>

			<section className="workbench" aria-labelledby="schedule-demo-title">
				<div className="bench-heading">
					<h2 id="schedule-demo-title">What happened while you were away?</h2>
					<p>Interactive example, no jobs run here.</p>
				</div>
				<div className="console">
					<div className="schedule-bar">
						<div>
							<strong>weekly-report</strong>
							<span>Package job</span>
						</div>
						<fieldset>
							<legend>Example schedule</legend>
							{(['weekly', 'daily'] as const).map((option) => (
								<button
									key={option}
									type="button"
									aria-pressed={cadence === option ? 'true' : 'false'}
									onClick={() => {
										setCadence(option)
									}}
								>
									{option === 'weekly' ? 'Every Friday' : 'Every day'}
								</button>
							))}
						</fieldset>
						<div className="cron">
							<code>{cadence === 'weekly' ? '0 8 * * 5' : '0 8 * * *'}</code>
							<span>08:00 · America/Denver</span>
						</div>
					</div>
					<div className="run-layout">
						<div
							className="run-list"
							role="group"
							aria-label="Inspect an example run"
						>
							{runs.map((item, index) => (
								<button
									key={item.label}
									type="button"
									aria-pressed={selected === index ? 'true' : 'false'}
									onClick={() => {
										setSelected(index)
									}}
								>
									<span>{item.time}</span>
									<strong>{item.label}</strong>
									<span aria-hidden="true">↗</span>
								</button>
							))}
						</div>
						<div className="run-detail" aria-live="polite">
							<div className="output">
								<span>Output</span>
								<h3>{run.output}</h3>
								<p>{run.message}</p>
							</div>
							<ol>
								{run.steps.map((step) => (
									<li key={step}>{step}</li>
								))}
							</ol>
						</div>
					</div>
				</div>
			</section>

			<section className="decision">
				<div>
					<h2>Does this need another agent run?</h2>
					<p>
						If the task needs a new decision each time, let an agent work
						through it. If you’ve already built the code, a Kody job can run it
						again.
					</p>
				</div>
				<div>
					<div className="choice">
						<h3>“Investigate what changed.”</h3>
						<p>
							Your package can call a model when the work needs judgment, such
							as summarizing new information or deciding which updates belong in
							a report.
						</p>
					</div>
					<div className="choice">
						<h3>“Run the report we built.”</h3>
						<p>
							A Kody package job runs your saved code, with its connected
							accounts and stored progress. It uses a model only when your code
							calls one.
						</p>
					</div>
					<SiteLink href="/docs/triggers">Set up a Kody schedule ↗</SiteLink>
				</div>
			</section>

			<section className="implementation">
				<div>
					<h2>A schedule belongs with the code.</h2>
					<p>
						Add the job to your package, leave the schedule off while you test
						it, then turn it on when you’re happy with the result.
					</p>
					<ol className="setup">
						<li>
							<strong>Choose the dates to include.</strong> Choose the sources,
							output destination, and what happens when a source is unavailable.
						</li>
						<li>
							<strong>Run a small preview.</strong> Run the job once and check
							what it creates or changes before putting it on a schedule.
						</li>
						<li>
							<strong>Save your progress.</strong> Store progress in the package
							so the next run knows where to start.
						</li>
					</ol>
					<SiteLink href="/docs/triggers">
						Read the jobs and triggers documentation ↗
					</SiteLink>
				</div>
				<div className="manifest">
					<div>
						package.json <span>Disabled example</span>
					</div>
					<pre>
						<code>{page.sections.find((section) => section.code)?.code}</code>
					</pre>
					<p>
						The entry file must exist. Set your timezone before turning the job
						on.
					</p>
				</div>
			</section>

			<section className="trigger">
				<h2>Not everything needs a clock.</h2>
				<dl>
					<div>
						<dt>An event just happened</dt>
						<dd>
							Use a webhook to start work when another service sends an event,
							or a subscription for events inside Kody.
						</dd>
					</div>
					<div>
						<dt>The work outlasts a request</dt>
						<dd>
							Use a durable workflow for work that takes longer than a single
							request can stay open.
						</dd>
					</div>
				</dl>
			</section>

			<section className="start" id="try-it">
				<div>
					<h2>Your next Friday report starts here.</h2>
					<p>
						Connect your agent to Kody and give it this prompt. Review the
						manual result before enabling the schedule.
					</p>
					<SiteLink href={routes.onboarding.href()} css={getPillButtonCss()}>
						Connect your agent
					</SiteLink>
				</div>
				<div>
					<blockquote>{page.prompt}</blockquote>
					<CopyTextButton
						value={page.prompt}
						idleLabel="Copy prompt"
						variant="pill"
					/>
				</div>
			</section>
			<nav className="closing-links" aria-label="Continue building">
				<SiteLink href="/use-cases/ai-workflow-automation">
					AI workflow automation
				</SiteLink>
				<SiteLink href="/integrations/slack">
					Deliver a report to Slack
				</SiteLink>
				<SiteLink href="/compare/n8n-alternatives">
					Compare n8n alternatives
				</SiteLink>
				<SiteLink href="/pricing">Kody pricing and limits</SiteLink>
			</nav>
		</article>
	)
}
const styles: CSSObject = {
	maxWidth: '1180px',
	margin: '0 auto',
	padding: '4rem 1.5rem 3rem',
	color: colors.text,
	'& *': { boxSizing: 'border-box' },
	'& h1, & h2, & h3, & p': { margin: 0 },
	'& h1, & h2, & h3': { fontFamily: typography.fontFamilyDisplay },
	'& h1': { fontSize: '3.6rem', lineHeight: 1.06, textWrap: 'balance' },
	'& h2': { fontSize: '2.35rem', lineHeight: 1.15, textWrap: 'balance' },
	'& h3': { fontSize: '1.35rem', lineHeight: 1.3 },
	'& p, & li, & dd': { lineHeight: 1.7 },
	'& a:focus-visible, & button:focus-visible': {
		outline: `3px solid ${colors.primaryText}`,
		outlineOffset: '4px',
	},
	'& .opening': {
		display: 'grid',
		gridTemplateColumns: '1.1fr 1fr',
		alignItems: 'center',
		gap: '3rem',
		paddingBottom: '4rem',
	},
	'& .lead': {
		fontSize: '1.2rem',
		maxWidth: '32rem',
		margin: '1.5rem 0 2rem',
		color: colors.textMuted,
	},
	'& .calendar': {
		border: `1px solid ${colors.border}`,
		background: colors.surface,
		transform: 'rotate(-2deg)',
		boxShadow: '8px 12px 0 rgba(120,120,90,0.1)',
	},
	'& .calendar-top': {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '0.5rem',
		justifyContent: 'space-between',
		padding: '1rem',
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.75rem',
		borderBottom: `1px solid ${colors.border}`,
	},
	'& .week': {
		display: 'grid',
		gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
		padding: '1.5rem 0.7rem',
		gap: '0.25rem',
	},
	'& .week > div': {
		display: 'flex',
		flexDirection: 'column',
		alignItems: 'center',
		gap: '0.75rem',
		padding: '0.65rem 0.1rem',
		minHeight: '7rem',
		borderRadius: '2rem',
		fontSize: '0.8rem',
	},
	'& .week strong': {
		fontSize: '1.5rem',
		fontFamily: typography.fontFamilyDisplay,
	},
	'& .week .due': {
		background: colors.primarySoftest,
		color: colors.primaryText,
		outline: `1px solid ${colors.primaryText}`,
	},
	'& .week small': { fontSize: '0.65rem' },
	'& .calendar-bottom': {
		borderTop: `1px solid ${colors.border}`,
		padding: '1rem',
		display: 'flex',
		alignItems: 'center',
		gap: '0.65rem',
		fontSize: '0.85rem',
	},
	'& .dot': {
		display: 'inline-block',
		width: '0.5rem',
		height: '0.5rem',
		borderRadius: '50%',
		background: colors.primaryText,
	},
	'& .workbench': { padding: '2rem 0 4.5rem' },
	'& .bench-heading': {
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'end',
		gap: '2rem',
		marginBottom: '1.5rem',
	},
	'& .bench-heading p': { fontSize: '0.85rem', color: colors.textMuted },
	'& .console': {
		border: `1px solid ${colors.border}`,
		background: colors.surface,
	},
	'& .schedule-bar': {
		display: 'flex',
		gap: '1.5rem',
		justifyContent: 'space-between',
		alignItems: 'center',
		padding: '1.5rem',
		borderBottom: `1px solid ${colors.border}`,
	},
	'& .schedule-bar > div': { display: 'grid', gap: '0.4rem' },
	'& .schedule-bar span': { color: colors.textMuted, fontSize: '0.8rem' },
	'& fieldset': { margin: 0, padding: 0, border: 0 },
	'& legend': {
		fontSize: '0.8rem',
		color: colors.textMuted,
		marginBottom: '0.4rem',
	},
	'& fieldset button': {
		padding: '0.55rem 0.75rem',
		border: `1px solid ${colors.border}`,
		background: 'transparent',
		fontSize: '0.85rem',
	},
	'& button[aria-pressed="true"]': {
		background: colors.primarySoftest,
		color: colors.primaryText,
	},
	'& .cron code': {
		fontFamily: typography.fontFamilyMono,
		fontSize: '1.15rem',
	},
	'& .run-layout': { display: 'grid', gridTemplateColumns: '18rem 1fr' },
	'& .run-list': { borderRight: `1px solid ${colors.border}` },
	'& .run-list button': {
		display: 'grid',
		gridTemplateColumns: '1fr auto',
		width: '100%',
		textAlign: 'left',
		padding: '1.5rem',
		gap: '0.6rem',
		border: 0,
		borderBottom: `1px solid ${colors.border}`,
		background: 'transparent',
	},
	'& .run-list button > span:first-child': {
		gridColumn: '1 / -1',
		fontSize: '0.75rem',
		color: colors.textMuted,
	},
	'& .run-list strong': { fontSize: '0.95rem' },
	'& .run-detail': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '2rem',
		padding: '2rem',
		minHeight: '19rem',
	},
	'& .output > span': { fontSize: '0.8rem', color: colors.textMuted },
	'& .output h3': { margin: '0.5rem 0 1rem', overflowWrap: 'anywhere' },
	'& .output p': { fontSize: '0.95rem', color: colors.textMuted },
	'& .run-detail ol': { margin: 0, paddingLeft: '1.5rem', fontSize: '0.85rem' },
	'& .run-detail li': { padding: '0 0 1rem 0.5rem' },
	'& .run-detail li::marker': { color: colors.primaryText },
	'& .decision, & .implementation, & .start': {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		gap: '4rem',
		padding: '4rem 0',
		borderTop: `1px solid ${colors.border}`,
	},
	'& .decision p, & .implementation p, & .start p': {
		marginTop: '1rem',
		color: colors.textMuted,
	},
	'& .choice': { marginBottom: '2rem' },
	'& .choice p': { marginTop: '0.6rem' },
	'& .setup': { paddingLeft: '1.25rem', marginBlock: '2rem' },
	'& .setup li': { paddingLeft: '0.5rem', marginBottom: '1.25rem' },
	'& .manifest': {
		minWidth: 0,
		background: colors.surface,
		border: `1px solid ${colors.border}`,
		alignSelf: 'start',
	},
	'& .manifest > div': {
		display: 'flex',
		justifyContent: 'space-between',
		gap: '1rem',
		padding: '1rem',
		borderBottom: `1px solid ${colors.border}`,
		fontSize: '0.8rem',
	},
	'& .manifest span': { color: colors.textMuted },
	'& pre': {
		margin: 0,
		padding: '1.5rem',
		overflowX: 'auto',
		fontFamily: typography.fontFamilyMono,
		fontSize: '0.8rem',
		lineHeight: 1.8,
	},
	'& .manifest p': {
		padding: '0 1.5rem 1.5rem',
		margin: 0,
		fontSize: '0.8rem',
	},
	'& .trigger': {
		display: 'grid',
		gridTemplateColumns: '1fr 1.5fr',
		gap: '3rem',
		padding: '3rem',
		background: colors.primarySoftest,
		marginBottom: '4rem',
	},
	'& dl': { margin: 0, display: 'grid', gap: '1.5rem' },
	'& dt': { fontWeight: 650, marginBottom: '0.4rem' },
	'& dd': { margin: 0, color: colors.textMuted },
	'& .start p': { marginBottom: '1.5rem' },
	'& blockquote': {
		margin: '0 0 1.5rem',
		lineHeight: 1.8,
		fontSize: '1.1rem',
		borderLeft: `3px solid ${colors.primaryText}`,
		paddingLeft: '1.5rem',
	},
	'& .closing-links': {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '1rem 2rem',
		paddingTop: '2rem',
		borderTop: `1px solid ${colors.border}`,
		fontSize: '0.9rem',
	},
	'@media (max-width: 850px)': {
		'& h1': { fontSize: '2.8rem' },
		'& h2': { fontSize: '2rem' },
		'& .opening': { gap: '2rem', gridTemplateColumns: '1fr' },
		'& .calendar': { maxWidth: '34rem', transform: 'none' },
		'& .schedule-bar': { flexWrap: 'wrap' },
		'& .run-layout': { gridTemplateColumns: '14rem 1fr' },
		'& .run-detail': { gridTemplateColumns: '1fr', gap: '1rem' },
		'& .decision, & .implementation, & .start': {
			gap: '2rem',
			gridTemplateColumns: '1fr',
		},
		'& .trigger': { gridTemplateColumns: '1fr', padding: '2rem' },
	},
	'@media (max-width: 540px)': {
		paddingTop: '2rem',
		'& h1': { fontSize: '2.35rem' },
		'& h2': { fontSize: '1.8rem' },
		'& .lead': { fontSize: '1.05rem' },
		'& .bench-heading': { display: 'block' },
		'& .bench-heading p': { marginTop: '0.75rem' },
		'& .run-layout': { gridTemplateColumns: '1fr' },
		'& .run-list': { borderRight: 0 },
		'& .run-list button': { padding: '1rem' },
		'& .run-detail': { padding: '1.25rem', minHeight: '25rem' },
		'& .schedule-bar': { padding: '1rem' },
		'& .calendar-top': { fontSize: '0.65rem' },
		'& .decision, & .implementation, & .start': { paddingBlock: '2.5rem' },
		'& .trigger': { padding: '1.5rem' },
		'& pre': { padding: '1rem', fontSize: '0.7rem' },
	},
}
