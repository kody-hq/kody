/** @jsxImportSource @emotion/react */
import {
	at,
	PrimitiveWidgetFrame,
	wire,
	wires,
} from '../../components/primitive-widget-parts.tsx'
/**
 * `/features/credentials` OAuth scenes. Account and package buttons sit outside
 * the keyed `.pw-run` so a replay does not drop focus. The run only holds
 * the wires, the hub, and the packets.
 */
export type IntegrationAccountId = 'personal' | 'work'
export type IntegrationEventId = 'first' | 'second'
export type IntegrationPackageId = 'brief' | 'prep' | 'planner'
const accounts = {
	personal: {
		name: 'google-personal',
		label: 'Personal',
		email: 'alex@personal.example',
		events: [
			{ id: 'first', text: '10:00 · Dentist appointment' },
			{ id: 'second', text: '18:30 · Dinner with Sam' },
		],
	},
	work: {
		name: 'google-work',
		label: 'Work',
		email: 'alex@company.example',
		events: [
			{ id: 'first', text: '09:00 · Project review' },
			{ id: 'second', text: '14:00 · Client check-in' },
		],
	},
} as const satisfies Record<
	IntegrationAccountId,
	{
		name: string
		label: string
		email: string
		events: ReadonlyArray<{
			id: IntegrationEventId
			text: string
		}>
	}
>
const packages = {
	brief: {
		name: 'weekly-brief',
		operation: "Read this week's calendar events",
		title: 'Your week, ready to review.',
		copy: "Monday's project review and Thursday's client check-in, collected in one brief.",
		request: 'read week',
		result: 'brief',
	},
	prep: {
		name: 'meeting-prep',
		operation: 'Read the next meeting',
		title: 'Walk in prepared.',
		copy: 'Project review, Monday at 09:00. Bring the launch brief and your open questions.',
		request: 'read next',
		result: 'prep notes',
	},
	planner: {
		name: 'day-planner',
		operation: "Read today's calendar",
		title: 'Make room for focused work.',
		copy: 'Your next meeting starts at 14:00. Keep the morning open for the launch page.',
		request: 'read today',
		result: 'day plan',
	},
} as const satisfies Record<
	IntegrationPackageId,
	{
		name: string
		operation: string
		title: string
		copy: string
		request: string
		result: string
	}
>
const packageOrder = [
	'brief',
	'prep',
	'planner',
] as const satisfies ReadonlyArray<IntegrationPackageId>
/** ViewBox y of each package button. The fan wires and lanes share these. */
const packageRowY = {
	brief: 64,
	prep: 102,
	planner: 136,
} as const satisfies Record<IntegrationPackageId, number>
/** ViewBox x of the saved card's right edge and the package column's left
 *  edge (31% and 71% in the CSS). */
const reuseCardLeft = 112
const reuseCardRight = 256
const heroHeight = 232
const reuseHeight = 308
const setupHeight = 300
function accountInfo(id: IntegrationAccountId) {
	switch (id) {
		case 'personal':
			return accounts.personal
		case 'work':
			return accounts.work
		default: {
			const unknown: never = id
			return unknown
		}
	}
}
function packageInfo(id: IntegrationPackageId) {
	switch (id) {
		case 'brief':
			return packages.brief
		case 'prep':
			return packages.prep
		case 'planner':
			return packages.planner
		default: {
			const unknown: never = id
			return unknown
		}
	}
}
function eventName(text: string) {
	return text.split(' · ')[1] ?? text
}
/** Short enough to travel the gap between Kody and the package. */
function packetEventName(text: string) {
	switch (text) {
		case '09:00 · Project review':
			return 'Review'
		case '14:00 · Client check-in':
			return 'Check-in'
		case '10:00 · Dentist appointment':
			return 'Dentist'
		case '18:30 · Dinner with Sam':
			return 'Dinner'
		default:
			return eventName(text)
	}
}
export function integrationAccountStatus(
	account: IntegrationAccountId,
	event: IntegrationEventId | null,
) {
	const info = accountInfo(account)
	const events = info.events.map((entry) => entry.text).join(' and ')
	const picked = info.events.find((entry) => entry.id === event)
	const received = `Requested upcoming events from ${info.name} through Kody. weekly-brief received ${events} for ${info.email}.`
	if (!picked) return received
	return `${received} ${picked.text} is in the brief.`
}
/**
 * A request or result label parked in the gap between two cards. It never
 * travels, so it cannot collide with a card; the animation only emphasizes
 * it. `dir` picks the arrow, which CSS swaps for up/down when stacked.
 */
function tag(dir: 'out' | 'back', x: number, y: number, label: string) {
	return (
		<span className={`pw-int-tag pw-int-tag-${dir}`} style={at(x, y)}>
			{label}
		</span>
	)
}
export function IntegrationsHeroScene(props: {
	account: IntegrationAccountId
	event: IntegrationEventId | null
	shot: number
	onAccount: (account: IntegrationAccountId) => void
	onEvent: (event: IntegrationEventId) => void
}) {
	const { account, event, shot, onAccount, onEvent } = props
	const info = accountInfo(account)
	const picked = info.events.find((entry) => entry.id === event)
	const backLabel = picked ? packetEventName(picked.text) : '2 events'
	return (
		<PrimitiveWidgetFrame
			id="integrations"
			size="full"
			height={heroHeight}
			className="pw-scene-int-hero"
			stack
		>
			<div className="pw-run" key={`${account}-${event ?? 'none'}-${shot}`}>
				{wires(
					<>
						{wire({
							key: 'out',
							d: 'M144 88 H230',
							on: true,
						})}
						{wire({
							key: 'back',
							d: 'M230 144 H144',
							on: true,
						})}
					</>,
					heroHeight,
				)}
				{tag('out', 52, 26, 'events?')}
				<div className="pw-hub pw-int-hero-hub" style={at(52, 50)}>
					Kody
				</div>
				{tag('back', 52, 74, backLabel)}
			</div>
			<div className="pw-node pw-int-brief">
				<span className="pw-int-kicker">
					weekly-brief · Read upcoming events
				</span>
				<strong className="pw-int-email">{info.email}</strong>
				<div className="pw-int-events">
					{info.events.map((entry) => (
						<button
							key={entry.id}
							type="button"
							className="pw-int-hit pw-int-event"
							aria-pressed={event === entry.id}
							onClick={() => onEvent(entry.id)}
						>
							{entry.text}
							<span className="pw-int-radio" aria-hidden="true"></span>
						</button>
					))}
				</div>
				<span className="pw-int-stamp" aria-hidden="true">
					{picked ? 'In the brief' : 'Returned'}
				</span>
			</div>
			<div
				className="pw-node pw-int-google"
				role="group"
				aria-labelledby="int-account-label"
			>
				<span className="pw-int-google-head">
					<span className="pw-mark">G</span>
					<strong id="int-account-label">Google</strong>
					<span className="pw-int-count">2 accounts</span>
				</span>
				{(['personal', 'work'] as const).map((id) => {
					const row = accountInfo(id)
					return (
						<button
							key={id}
							type="button"
							className="pw-int-hit pw-int-account"
							aria-pressed={account === id}
							onClick={() => onAccount(id)}
						>
							<span className="pw-int-account-copy">
								<strong>{row.name}</strong>
								<small>{row.label}</small>
							</span>
							<span className="pw-int-radio" aria-hidden="true"></span>
						</button>
					)
				})}
			</div>
		</PrimitiveWidgetFrame>
	)
}
export function IntegrationsReuseScene(props: {
	selected: IntegrationPackageId
	shot: number
	onSelect: (id: IntegrationPackageId) => void
}) {
	const { selected, shot, onSelect } = props
	const info = packageInfo(selected)
	const rowY = packageRowY[selected]
	return (
		<PrimitiveWidgetFrame
			id="integrations"
			size="full"
			height={reuseHeight}
			className="pw-scene-int-reuse"
			stack
		>
			<div className="pw-run" key={`${selected}-${shot}`}>
				{wires(
					packageOrder.flatMap((id) => {
						const y = packageRowY[id]
						if (id !== selected) {
							return [
								wire({
									key: `${id}-idle`,
									d: `M${reuseCardRight} ${y} H${reuseCardLeft}`,
								}),
							]
						}
						return [
							wire({
								key: `${id}-out`,
								d: `M${reuseCardRight} ${y - 7} H${reuseCardLeft}`,
								on: true,
							}),
							wire({
								key: `${id}-back`,
								d: `M${reuseCardLeft} ${y + 7} H${reuseCardRight}`,
								on: true,
							}),
						]
					}),
					reuseHeight,
				)}
				{tag('out', 50, 7, info.request)}
				<div className="pw-int-bus">Kody</div>
				{tag('back', 50, 53, info.result)}
			</div>
			<div className="pw-node pw-int-saved">
				<span className="pw-int-saved-head">
					<span className="pw-mark" aria-hidden="true">
						G
					</span>
					<strong>google-work</strong>
				</span>
				<small className="pw-int-saved-email">
					alex@
					<wbr />
					company.example
				</small>
				<span className="pw-int-pill">Saved connection</span>
			</div>
			<fieldset className="pw-int-picker">
				<legend className="visually-hidden">
					Choose the example package using google-work
				</legend>
				{packageOrder.map((id) => {
					const row = packageInfo(id)
					const y = packageRowY[id]
					return (
						<button
							key={id}
							type="button"
							className="pw-int-hit pw-int-pack"
							style={{ top: `${(y / reuseHeight) * 100}%` }}
							aria-pressed={selected === id}
							onClick={() => onSelect(id)}
						>
							{row.name}
							<span className="pw-int-radio" aria-hidden="true"></span>
						</button>
					)
				})}
			</fieldset>
			<div className="pw-node pw-int-result" aria-live="polite">
				<small id="ia-operation">{info.operation}</small>
				<h3 id="ia-output-title">{info.title}</h3>
				<p id="ia-output-copy">{info.copy}</p>
			</div>
		</PrimitiveWidgetFrame>
	)
}
const setupSteps = [
	{
		title: 'Choose the service.',
		detail: 'Google',
	},
	{
		title: 'Finish sign-in.',
		detail: accounts.work.email,
	},
	{
		title: 'Test a small request.',
		detail: '09:00 · Project review',
	},
] as const
export function IntegrationsSetupScene() {
	return (
		<PrimitiveWidgetFrame
			id="integrations"
			size="full"
			height={setupHeight}
			className="pw-scene-int-setup"
			stack
		>
			<div className="pw-run" key="setup">
				<div className="pw-int-board">
					<ol className="pw-int-steps">
						{setupSteps.map((step, index) => (
							<li key={step.title} className="pw-int-step">
								<span className="pw-int-num" aria-hidden="true">
									{index + 1}
								</span>
								<span className="pw-int-step-copy">
									<strong>{step.title}</strong>
									<small>{step.detail}</small>
								</span>
								<span className="pw-int-check" aria-hidden="true">
									✓
								</span>
							</li>
						))}
					</ol>
					<div className="pw-int-test">
						<span className="pw-int-chip">list 1 event</span>
						<span
							className="pw-int-link pw-int-link-a"
							aria-hidden="true"
						></span>
						<div className="pw-hub pw-int-hub">Kody</div>
						<span
							className="pw-int-link pw-int-link-b"
							aria-hidden="true"
						></span>
						<span className="pw-int-chip pw-int-chip-account">
							<span className="pw-mark" aria-hidden="true">
								G
							</span>
							<span>
								<strong>google-work</strong>
								<small>09:00 · Project review</small>
							</span>
						</span>
					</div>
					<div className="pw-int-lock">
						<div className="pw-int-lock-head">
							<span className="pw-mark" aria-hidden="true">
								G
							</span>
							<strong>google-work</strong>
							<span className="pw-int-pill">
								<span className="pw-int-padlock" aria-hidden="true"></span>
								Specific packages
							</span>
						</div>
						<div className="pw-int-gate-row" data-gate="deny">
							<span className="pw-int-id">mail-send</span>
							<span className="pw-int-act">send</span>
							<span className="pw-int-verdict">
								<span aria-hidden="true">✕ </span>Refused
							</span>
						</div>
						<div className="pw-int-gate-row" data-gate="allow">
							<span className="pw-int-id">gmail-drafts</span>
							<span className="pw-int-act">create draft</span>
							<span className="pw-int-verdict">
								<span aria-hidden="true">✓ </span>Passed
							</span>
						</div>
						<div className="pw-int-grant">
							<span>Allowed package</span>
							<code>gmail-drafts</code>
						</div>
						<div className="pw-int-grant pw-int-behavior">
							<span>Published behavior</span>
							<strong>Create a draft for review</strong>
						</div>
					</div>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
