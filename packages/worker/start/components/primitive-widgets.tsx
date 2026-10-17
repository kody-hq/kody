/** @jsxImportSource @emotion/react */
import { type ReactNode, type CSSProperties } from 'react'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import { at, icon, wires, wire, choice } from './primitive-widget-parts.tsx'
// Memory: one saved preference, recalled by whichever agent asks.

export const memoryAgents = [
	{ id: 'claude', name: 'Claude', x: 20 },
	{ id: 'cursor', name: 'Cursor', x: 50 },
	{ id: 'chatgpt', name: 'ChatGPT', x: 80 },
] as const

export type MemoryAgentId = (typeof memoryAgents)[number]['id']

export function memoryScene(state: {
	agent: MemoryAgentId
	shot?: number
	onAgent?: (id: MemoryAgentId) => void
}) {
	const { agent, shot = 0, onAgent } = state
	return (
		<>
			{wires(
				memoryAgents.map((entry, i) => {
					const x = (entry.x / 100) * 360
					return wire({
						key: entry.id,
						d: `M180 70 C180 108 ${x} 104 ${x} 142`,
						i,
						on: agent === entry.id,
						shot: agent === entry.id ? shot : 0,
					})
				}),
			)}
			<div className="pw-node pw-note" style={at(50, 21)}>
				<span className="pw-kicker">✎ Writing preference</span>
				<strong>Lead with the decision.</strong>
			</div>
			{memoryAgents.map((entry, i) =>
				choice({
					key: entry.id,
					class: 'pw-node pw-agent',
					selected: agent === entry.id,
					onPick: onAgent ? () => onAgent(entry.id) : undefined,
					label: onAgent ? `Ask ${entry.name}` : undefined,
					style: at(entry.x, 80, { '--i': String(i) }),
					children: (
						<>
							{icon(entry.id)}
							{entry.name}
						</>
					),
				}),
			)}
		</>
	)
}

// Packages: write code once, publish it as a package, then any agent
// invokes it and gets the result back.

const packageLines = [
	['export default (', 'cal', ') => {'],
	['  const week = cal.', 'week', '()'],
	['  return ', 'summarize', '(week)'],
	['}', '', ''],
] as const

export const packageChanges = [
	'week.sort(byPriority)',
	'week.filter(isWorkday)',
	'week.slice(0, 5)',
] as const

export const packageCallers = [
	{ id: 'claude', name: 'Claude', y: 36 },
	{ id: 'cursor', name: 'Cursor', y: 60 },
	{ id: 'chatgpt', name: 'ChatGPT', y: 84 },
] as const

export type PackageCallerId = (typeof packageCallers)[number]['id']

/** Package box edges and caller chip edge, in stage units. */
const packageBox = { left: 204, right: 242, y: 92 }
const packageCallerEdge = 280

export function packagesScene(state: {
	version: number
	caller?: PackageCallerId
	invoked?: number
	onCaller?: (id: PackageCallerId) => void
}) {
	const { version, caller = 'claude', invoked = 0, onCaller } = state
	const change =
		version > 0 ? packageChanges[(version - 1) % packageChanges.length] : null
	const lines = change
		? [
				packageLines[0],
				packageLines[1],
				['  ', change, ''] as const,
				packageLines[2],
				packageLines[3],
			]
		: packageLines
	return (
		<div
			className="pw-run"
			key={`v${version}-${invoked}`}
			data-invoked={invoked > 0 ? '' : undefined}
		>
			{wires(
				<>
					{wire({
						key: 'publish',
						d: `M173 ${packageBox.y} L${packageBox.left} ${packageBox.y}`,
						on: true,
					})}
					{packageCallers.map((entry) => {
						const y = (entry.y / 100) * 200
						const selected = caller === entry.id
						const out = `M${packageCallerEdge} ${y} C${packageBox.right + 20} ${y} ${packageBox.right + 18} ${packageBox.y} ${packageBox.right} ${packageBox.y}`
						const back = `M${packageBox.right} ${packageBox.y} C${packageBox.right + 18} ${packageBox.y} ${packageBox.right + 20} ${y} ${packageCallerEdge} ${y}`
						return (
							<g
								key={entry.id}
								className="pw-wire pw-call-wire"
								data-on={selected ? '' : undefined}
							>
								<path className="pw-line" d={out} />
								{selected ? (
									<>
										<path className="pw-call" d={out} pathLength="100" />
										<path
											className="pw-call pw-call-back"
											d={back}
											pathLength="100"
										/>
									</>
								) : null}
							</g>
						)
					})}
				</>,
			)}
			<span className="pw-step pw-step-create" style={at(4, 9)}>
				1 · Create
			</span>
			<span className="pw-step pw-step-invoke" style={at(88, 9)}>
				2 · Invoke
			</span>
			<div className="pw-node pw-editor" style={at(4, 56)}>
				<span className="pw-kicker">◇ weekly-brief / brief.ts</span>
				<code className="pw-code">
					{lines.map(([lead, word, tail], i) => (
						<span
							key={`${i}-${word}`}
							className="pw-code-line"
							data-diff={change && word === change ? '' : undefined}
							style={{ '--i': String(i) } as CSSProperties}
						>
							{lead}
							<b>{word}</b>
							{tail}
						</span>
					))}
				</code>
			</div>
			<div className="pw-box-wrap" style={at(62, 52)}>
				<span className="pw-box" aria-hidden="true">
					<span className="pw-box-lid"></span>
				</span>
				<span className="pw-box-name">weekly-brief</span>
				<span className="pw-badge">Published v1.{version + 2}</span>
			</div>
			<span className="pw-run-call" style={at(62, 89)}>
				› run weekly-brief
			</span>
			{packageCallers.map((entry) =>
				choice({
					key: entry.id,
					class: 'pw-node pw-caller',
					selected: caller === entry.id,
					onPick: onCaller ? () => onCaller(entry.id) : undefined,
					label: onCaller ? `Invoke from ${entry.name}` : undefined,
					style: at(77.8, entry.y),
					children: (
						<>
							{icon(entry.id)}
							{entry.name}
							{caller === entry.id ? (
								<span className="pw-ret" aria-hidden="true">
									✓
								</span>
							) : null}
						</>
					),
				}),
			)}
		</div>
	)
}

// Triggers: a webhook, a schedule, or an email wakes the same package.

export const triggerSources = [
	{ id: 'webhook', name: 'Webhook', glyph: '↗', y: 22 },
	{ id: 'schedule', name: 'Schedule', glyph: '', y: 50 },
	{ id: 'email', name: 'Email', glyph: '✉', y: 78 },
] as const

export type TriggerSourceId = (typeof triggerSources)[number]['id']

export function triggersScene(state: {
	runs: number
	fired?: TriggerSourceId | null
	shot?: number
	onFire?: (id: TriggerSourceId) => void
}) {
	const { runs, fired = null, shot = 0, onFire } = state
	return (
		<>
			{wires(
				triggerSources.map((source, i) => {
					const y = (source.y / 100) * 200
					return wire({
						key: source.id,
						d: `M112 ${y} C162 ${y} 160 100 214 100`,
						i,
						on: fired === source.id,
						shot: fired === source.id ? shot : 0,
					})
				}),
			)}
			{triggerSources.map((source, i) =>
				choice({
					key: source.id,
					class: 'pw-node pw-source',
					selected: fired === source.id,
					onPick: onFire ? () => onFire(source.id) : undefined,
					label: onFire
						? `Fire ${source.name.toLowerCase()} trigger`
						: undefined,
					style: at(17, source.y, { '--i': String(i) }),
					children: (
						<>
							{source.id === 'schedule' ? (
								<span className="pw-clock" aria-hidden="true"></span>
							) : (
								<span className="pw-glyph" aria-hidden="true">
									{source.glyph}
								</span>
							)}
							{source.name}
						</>
					),
				}),
			)}
			<div className="pw-node pw-fn" style={at(76, 50)}>
				<span className="pw-fn-mark" aria-hidden="true">
					f
				</span>
				<span>
					<strong>purchase-thanks</strong>
					<span className="pw-kicker pw-count" key={`runs-${runs}`}>
						{runs} runs today
					</span>
				</span>
			</div>
		</>
	)
}

// Integrations: a package asks a connection for data through Kody, the
// answer comes back the same way, and acting on it writes back out.

export const integrationSlots = [
	{ id: 'tue', label: 'Tue 10:00', short: 'Tue', col: 0, top: 18 },
	{ id: 'wed', label: 'Wed 2:30', short: 'Wed', col: 1, top: 58 },
	{ id: 'thu', label: 'Thu 9:15', short: 'Thu', col: 2, top: 8 },
] as const

export type IntegrationSlotId = (typeof integrationSlots)[number]['id']

const calendarBusy = [
	{ col: 0, top: 50, height: 30 },
	{ col: 1, top: 12, height: 34 },
	{ col: 2, top: 38, height: 26 },
	{ col: 2, top: 72, height: 20 },
] as const

export function integrationsScene(state: {
	booked?: IntegrationSlotId | null
	shot?: number
	onBook?: (id: IntegrationSlotId) => void
}) {
	const { booked = null, shot = 0, onBook } = state
	const slot = integrationSlots.find((entry) => entry.id === booked)
	return (
		<div
			className="pw-run"
			key={`ask-${shot}`}
			data-booked={slot ? '' : undefined}
		>
			{wires(
				<>
					{wire({ d: 'M136 82 L242 82', on: true })}
					{wire({ d: 'M242 118 L136 118', on: true })}
				</>,
			)}
			<div className="pw-node pw-planner" style={at(4, 50)}>
				<span className="pw-kicker">◇ meet-finder</span>
				<strong>Sync with Sam</strong>
				<span className="pw-planner-wait" aria-hidden="true">
					Checking google-work…
				</span>
				{integrationSlots.map((entry, i) =>
					choice({
						key: entry.id,
						class: 'pw-slot',
						selected: booked === entry.id,
						onPick: onBook ? () => onBook(entry.id) : undefined,
						label: onBook ? `Book ${entry.label}` : undefined,
						style: { '--i': String(i) },
						children: (
							<>
								{entry.label}
								{booked === entry.id ? (
									<span className="pw-ret" aria-hidden="true">
										✓
									</span>
								) : null}
							</>
						),
					}),
				)}
			</div>
			<div className="pw-hub" style={at(52.4, 50)}>
				Kody
			</div>
			<div className="pw-node pw-cal" style={at(96, 50)}>
				<span className="pw-cal-head">
					<span className="pw-mark" aria-hidden="true">
						G
					</span>
					google-work
				</span>
				<span className="pw-cal-days" aria-hidden="true">
					<span>Tue</span>
					<span>Wed</span>
					<span>Thu</span>
				</span>
				<span className="pw-cal-grid" aria-hidden="true">
					{calendarBusy.map((block, i) => (
						<span
							key={`busy-${i}`}
							className="pw-cal-busy"
							style={
								{
									'--col': String(block.col),
									top: `${block.top}%`,
									height: `${block.height}%`,
								} as CSSProperties
							}
						></span>
					))}
					{integrationSlots.map((entry) => (
						<span
							key={entry.id}
							className="pw-cal-open"
							data-on={booked === entry.id ? '' : undefined}
							style={
								{
									'--col': String(entry.col),
									top: `${entry.top}%`,
								} as CSSProperties
							}
						></span>
					))}
				</span>
			</div>
			<div
				className="pw-lane"
				style={{ left: '43%', width: '19%', top: '41%' } as CSSProperties}
			>
				<span className="pw-packet">
					{slot ? `book ${slot.short}` : 'free times?'}
				</span>
			</div>
			<div
				className="pw-lane pw-lane-back"
				style={{ left: '43%', width: '19%', top: '59%' } as CSSProperties}
			>
				<span className="pw-packet">{slot ? 'booked ✓' : '3 open'}</span>
			</div>
		</div>
	)
}

// Apps: a prompt turns into a small hosted app with its own look.

export const appPrompts = [
	{
		id: 'intake',
		label: 'Project intake',
		prompt: 'Make me a project intake form',
		action: 'Submit',
		done: 'Sent to #projects',
	},
	{
		id: 'reading',
		label: 'Reading list',
		prompt: 'Build a page to track my reading',
		action: '+ Add book',
		done: 'Added to the shelf',
	},
	{
		id: 'habits',
		label: 'Habit tracker',
		prompt: 'I want a tiny habit tracker',
		action: 'Check in',
		done: '13-day streak',
	},
] as const

export type AppPromptId = (typeof appPrompts)[number]['id']

type AppPrompt = (typeof appPrompts)[number]

const readingShelf = [
	{ title: 'Piranesi', hue: 200, read: 100 },
	{ title: 'Dune', hue: 60, read: 72 },
	{ title: 'Circe', hue: 20, read: 35 },
] as const

const habitRows = [
	{ name: 'Walk', days: [1, 1, 1, 1, 1, 1] },
	{ name: 'Read', days: [1, 0, 1, 1, 1, 1] },
	{ name: 'Water', days: [1, 1, 1, 0, 1, 1] },
	{ name: 'Stretch', days: [0, 1, 1, 1, 0, 1] },
] as const

function appAction(app: AppPrompt) {
	return (
		<span
			className="pw-app-foot pw-ap-part"
			style={{ '--i': '4' } as CSSProperties}
		>
			<span className="pw-app-action">
				{app.action}
				<span className="pw-cursor" aria-hidden="true"></span>
			</span>
			<span className="pw-toast">{app.done}</span>
		</span>
	)
}

function appBody(app: AppPrompt): ReactNode {
	switch (app.id) {
		case 'intake':
			return (
				<>
					<span
						className="pw-in-head pw-ap-part"
						style={{ '--i': '0' } as CSSProperties}
					>
						<strong className="pw-app-title">{app.label}</strong>
						<span className="pw-in-tag">Q4</span>
					</span>
					<span className="pw-in-body">
						<span
							className="pw-in-row pw-ap-part"
							style={{ '--i': '1' } as CSSProperties}
						>
							<span>Project</span>
							<span className="pw-input">Autumn launch</span>
						</span>
						<span
							className="pw-in-row pw-ap-part"
							style={{ '--i': '2' } as CSSProperties}
						>
							<span>Due</span>
							<span className="pw-input">Nov 14</span>
						</span>
						<span
							className="pw-in-row pw-ap-part"
							style={{ '--i': '3' } as CSSProperties}
						>
							<span>Team</span>
							<span className="pw-in-team" aria-hidden="true">
								<span style={{ '--team-hue': '30' } as CSSProperties}>AK</span>
								<span style={{ '--team-hue': '200' } as CSSProperties}>SM</span>
								<span style={{ '--team-hue': '140' } as CSSProperties}>JR</span>
							</span>
						</span>
						<span
							className="pw-in-row pw-ap-part"
							style={{ '--i': '3' } as CSSProperties}
						>
							<span>Priority</span>
							<span className="pw-in-seg">
								<span>Low</span>
								<span>Med</span>
								<span data-on="">High</span>
							</span>
						</span>
						{appAction(app)}
					</span>
				</>
			)
		case 'reading':
			return (
				<>
					<span
						className="pw-rd-head pw-ap-part"
						style={{ '--i': '0' } as CSSProperties}
					>
						<strong className="pw-app-title">{app.label}</strong>
						<span>3 of 12 this year</span>
					</span>
					<span className="pw-rd-shelf">
						{readingShelf.map((book, i) => (
							<span
								key={book.title}
								className="pw-rd-book pw-ap-part"
								style={
									{
										'--i': String(i + 1),
										'--book-hue': String(book.hue),
										'--read': `${book.read}%`,
									} as CSSProperties
								}
							>
								<b>{book.title}</b>
							</span>
						))}
						<span
							className="pw-rd-book pw-app-new"
							style={{ '--book-hue': '150', '--read': '0%' } as CSSProperties}
						>
							<b>Kindred</b>
						</span>
					</span>
					{appAction(app)}
				</>
			)
		case 'habits':
			return (
				<>
					<span
						className="pw-hb-head pw-ap-part"
						style={{ '--i': '0' } as CSSProperties}
					>
						<strong className="pw-app-title">{app.label}</strong>
						<span>This week</span>
					</span>
					<span className="pw-hb-grid">
						{habitRows.map((row, i) => (
							<span
								key={row.name}
								className="pw-hb-row pw-ap-part"
								style={{ '--i': String(i + 1) } as CSSProperties}
							>
								<span className="pw-hb-name">{row.name}</span>
								{row.days.map((day, d) => (
									<span
										key={`${row.name}-${d}`}
										className="pw-hb-dot"
										data-on={day ? '' : undefined}
									></span>
								))}
								<span className="pw-hb-dot pw-hb-today">
									<span className="pw-hb-fill pw-app-new"></span>
								</span>
							</span>
						))}
					</span>
					{appAction(app)}
				</>
			)
		default: {
			const unknown: never = app
			throw new Error(`Unknown app: ${String(unknown)}`)
		}
	}
}

export function appsScene(state: { prompt: AppPromptId; shot?: number }) {
	const app =
		appPrompts.find((entry) => entry.id === state.prompt) ?? appPrompts[0]
	return (
		<div className="pw-run" key={`${app.id}-${state.shot ?? 0}`}>
			<div className="pw-node pw-prompt" style={at(4, 4)}>
				<span className="pw-prompt-text">› {app.prompt}</span>
			</div>
			<div className="pw-node pw-window" data-app={app.id} style={at(18, 22)}>
				<span className="pw-chrome">
					<span className="pw-chrome-dots" aria-hidden="true"></span>
					kody.app/{app.id}
				</span>
				<span className="pw-app">{appBody(app)}</span>
			</div>
		</div>
	)
}

/** Each scene at rest, for the homepage cards. */
export function primitiveRestScene(id: LandingPrimitiveId): ReactNode {
	switch (id) {
		case 'memory':
			return memoryScene({ agent: 'cursor' })
		case 'packages':
			return packagesScene({ version: 0 })
		case 'triggers':
			return triggersScene({ runs: 12 })
		case 'integrations':
			return integrationsScene({})
		case 'apps':
			return appsScene({ prompt: 'intake' })
		default: {
			const unknown: never = id
			throw new Error(`Unknown primitive: ${String(unknown)}`)
		}
	}
}
