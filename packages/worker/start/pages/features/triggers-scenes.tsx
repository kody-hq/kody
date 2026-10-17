import {
	at,
	icon,
	PrimitiveWidgetFrame,
	wire,
	wires,
} from '../../components/primitive-widget-parts.tsx'
import { triggerExamples, signals } from './triggers-data.ts'
/**
 * `/features/triggers` scenes. The page's own buttons drive them; each scene
 * holds the visible example, and `public/feature-scenes/triggers.css`
 * animates it. A keyed `.pw-run` restarts the timeline on every click.
 * Without `data-motion` the markup is already the finished run.
 */
export type TriggerExampleId = keyof typeof triggerExamples
export type SignalId = keyof typeof signals
export type ScanResult = '' | 'clean' | 'flake'
type SourceKind = 'stripe' | 'github' | 'mail' | 'clock'
type HeroRow = {
	label: string
	value: string
}
type HeroLog = {
	time: string
	text: string
}
const signalHeight = 250
const scanHeight = 280
const runBases: Record<TriggerExampleId, number> = {
	purchase: 0x4c91,
	issue: 0x19ae,
	email: 0xb07d,
	schedule: 0xd4f0,
}
function triggerRunId(example: TriggerExampleId, shot: number) {
	const next = (runBases[example] + shot * 0x117) & 0xffff
	return `run_${next.toString(16).padStart(4, '0')}`
}
function triggerDuration(
	example: TriggerExampleId,
	otherAddress: boolean,
	showFlake: boolean,
) {
	switch (example) {
		case 'purchase':
			return '1.2s'
		case 'issue':
			return '0.9s'
		case 'email':
			return otherAddress ? '0.2s' : '0.4s'
		case 'schedule':
			return showFlake ? '2.6s' : '2.1s'
		default: {
			const unknown: never = example
			return unknown
		}
	}
}
function sourceKind(example: TriggerExampleId): SourceKind {
	switch (example) {
		case 'purchase':
			return 'stripe'
		case 'issue':
			return 'github'
		case 'email':
			return 'mail'
		case 'schedule':
			return 'clock'
		default: {
			const unknown: never = example
			return unknown
		}
	}
}
function SourceMark(kind: SourceKind) {
	switch (kind) {
		case 'stripe':
			return icon('stripe')
		case 'github':
			return icon('github')
		case 'mail':
			return <span className="pw-trg-mail" aria-hidden="true"></span>
		case 'clock':
			return <span className="pw-clock" aria-hidden="true"></span>
		default: {
			const unknown: never = kind
			return unknown
		}
	}
}
function sourceName(kind: SourceKind) {
	switch (kind) {
		case 'stripe':
			return 'Stripe'
		case 'github':
			return 'GitHub'
		case 'mail':
			return 'Inbox'
		case 'clock':
			return 'Schedule'
		default: {
			const unknown: never = kind
			return unknown
		}
	}
}
function heroRows(
	example: TriggerExampleId,
	otherAddress: boolean,
): ReadonlyArray<HeroRow> {
	switch (example) {
		case 'purchase':
			return [
				{ label: 'Event', value: 'checkout.session' },
				{ label: 'Status', value: '.completed · paid' },
				{ label: 'Customer', value: 'Maya Chen · $48' },
			]
		case 'issue':
			return [
				{ label: 'Event', value: 'issue opened' },
				{ label: 'Issue', value: '#184 weekly-brief' },
				{ label: 'Repo', value: 'kody-hq/kody' },
			]
		case 'email':
			return otherAddress
				? [
						{ label: 'From', value: 'sam@other.test' },
						{ label: 'To', value: 'you@kody' },
						{ label: 'Tag', value: 'no plus-tag' },
					]
				: [
						{ label: 'From', value: 'Maya Chen' },
						{ label: 'To', value: 'you+thanks' },
						{ label: 'Subject', value: 'Order 1042' },
					]
		case 'schedule':
			return [
				{ label: 'Tick', value: '04:00 daily' },
				{ label: 'Zone', value: 'America/Denver' },
				{ label: 'Job', value: 'flake-hunter' },
			]
		default: {
			const unknown: never = example
			return unknown
		}
	}
}
function heroLogs(
	example: TriggerExampleId,
	otherAddress: boolean,
	showFlake: boolean,
): ReadonlyArray<HeroLog> {
	switch (example) {
		case 'purchase':
			return [
				{ time: '0.2s', text: 'signature ok' },
				{ time: '0.6s', text: 'session paid' },
				{ time: '1.2s', text: 'draft saved' },
			]
		case 'issue':
			return [
				{ time: '0.1s', text: 'delivery ok' },
				{ time: '0.4s', text: 'label set' },
				{ time: '0.9s', text: 'queued' },
			]
		case 'email':
			return otherAddress
				? [
						{ time: '0.1s', text: 'sender read' },
						{ time: '0.2s', text: 'no tag' },
						{ time: '0.2s', text: 'skipped' },
					]
				: [
						{ time: '0.1s', text: 'tag matched' },
						{ time: '0.2s', text: 'started' },
						{ time: '0.4s', text: 'draft saved' },
					]
		case 'schedule':
			return showFlake
				? [
						{ time: '0.4s', text: 'scan CI' },
						{ time: '1.3s', text: 'flake found' },
						{ time: '2.6s', text: 'call agent' },
					]
				: [
						{ time: '0.4s', text: 'scan CI' },
						{ time: '1.1s', text: 'no flake' },
						{ time: '2.1s', text: 'end quietly' },
					]
		default: {
			const unknown: never = example
			return unknown
		}
	}
}
function heroArtifact(
	example: TriggerExampleId,
	otherAddress: boolean,
	showFlake: boolean,
) {
	switch (example) {
		case 'purchase':
			return {
				kicker: 'Gmail draft',
				lines: ['To Maya Chen', 'Thanks for joining Orchard.'],
				chip: 'Not sent',
				packet: 'draft',
			}
		case 'issue':
			return {
				kicker: 'Triage label',
				lines: ['needs-triage', '#184 weekly-brief'],
				chip: 'Queued',
				packet: 'label',
			}
		case 'email':
			return otherAddress
				? {
						kicker: 'No action',
						lines: ['sam@other.test', 'No handler started.'],
						chip: 'Skipped',
						packet: 'skip',
					}
				: {
						kicker: 'Reply draft',
						lines: ['Re: Order 1042', 'To Maya Chen'],
						chip: 'Not sent',
						packet: 'reply',
					}
		case 'schedule':
			return showFlake
				? {
						kicker: 'Report',
						lines: ['brief.test.ts', 'Agent called'],
						chip: 'Investigate',
						packet: 'agent',
					}
				: {
						kicker: 'Report',
						lines: ['142 CI runs', 'No notification'],
						chip: 'Quiet',
						packet: 'report',
					}
		default: {
			const unknown: never = example
			return unknown
		}
	}
}
function inPacket(example: TriggerExampleId) {
	switch (example) {
		case 'purchase':
			return 'paid'
		case 'issue':
			return '#184'
		case 'email':
			return 'mail'
		case 'schedule':
			return 'tick'
		default: {
			const unknown: never = example
			return unknown
		}
	}
}
const signalRows: ReadonlyArray<{
	id: SignalId
	label: string
	y: number
}> = [
	{ id: 'webhook', label: 'Webhook', y: 14 },
	{ id: 'inbox', label: 'Inbox', y: 36 },
	{ id: 'package', label: 'Package', y: 58 },
	{ id: 'clock', label: 'Clock', y: 80 },
]
function signalMark(id: SignalId) {
	switch (id) {
		case 'webhook':
			return icon('stripe')
		case 'inbox':
			return <span className="pw-trg-mail" aria-hidden="true"></span>
		case 'package':
			return (
				<span className="pw-trg-diamond" aria-hidden="true">
					◇
				</span>
			)
		case 'clock':
			return <span className="pw-clock" aria-hidden="true"></span>
		default: {
			const unknown: never = id
			return unknown
		}
	}
}
function signalCard(id: SignalId) {
	switch (id) {
		case 'webhook':
			return {
				kicker: 'Thank-you draft',
				lines: ['Maya Chen · $48.00', 'Saved for review'],
			}
		case 'inbox':
			return {
				kicker: 'Plus-tag thanks',
				lines: ['you+thanks matched', 'Reply draft saved'],
			}
		case 'package':
			return {
				kicker: 'purchase.completed',
				lines: ['Thanks · Ledger', 'Same account'],
			}
		case 'clock':
			return {
				kicker: 'Daily 04:00',
				lines: ['Previous 24h of CI', 'Report or silence'],
			}
		default: {
			const unknown: never = id
			return unknown
		}
	}
}
function signalWire(y: number) {
	const fromY = Math.round((y / 100) * signalHeight)
	const toY = Math.round(0.22 * signalHeight)
	return `M122 ${fromY} C168 ${fromY} 176 ${toY} 209 ${toY}`
}
export function TriggerHeroScene(props: {
	example: TriggerExampleId
	result: string
	otherAddress: boolean
	showFlake: boolean
	shot: number
}) {
	const { example, result, otherAddress, showFlake, shot } = props
	const kind = sourceKind(example)
	const rows = heroRows(example, otherAddress)
	const logs = heroLogs(example, otherAddress, showFlake)
	const artifact = heroArtifact(example, otherAddress, showFlake)
	const event = triggerExamples[example]
	const arrived = inPacket(example)
	return (
		<PrimitiveWidgetFrame
			id="triggers"
			size="full"
			className="pw-scene-trg-hero"
			stack
		>
			<div
				className="pw-run"
				key={`${example}-${otherAddress}-${showFlake}-${shot}`}
				data-example={example}
			>
				<div className="pw-node pw-trg-card pw-trg-source">
					<div className="pw-trg-head">
						{SourceMark(kind)}
						<span>
							<span className="pw-kicker">When · {sourceName(kind)}</span>
							<strong>{event.when}</strong>
						</span>
					</div>
					<div className="pw-trg-rows">
						{rows.map((row) => (
							<p key={row.label}>
								<span>{row.label}</span>
								<span>{row.value}</span>
							</p>
						))}
					</div>
				</div>
				<div className="pw-trg-link pw-trg-link-in" aria-hidden="true">
					<span className="pw-packet">{arrived}</span>
				</div>
				<div className="pw-node pw-trg-card pw-trg-logs">
					<div className="pw-trg-head">
						<span className="pw-trg-fn" aria-hidden="true">
							ƒ
						</span>
						<span>
							<span className="pw-kicker">Run package</span>
							<strong>{event.package}</strong>
						</span>
					</div>
					<div className="pw-trg-loglist">
						{logs.map((line) => (
							<p key={line.text} className="pw-trg-log">
								<span className="pw-trg-t">{line.time}</span>
								{line.text}
							</p>
						))}
					</div>
					<p className="pw-trg-meta">
						<span className="pw-trg-runid">{triggerRunId(example, shot)}</span>
						<span className="pw-trg-dur">
							{triggerDuration(example, otherAddress, showFlake)}
						</span>
					</p>
				</div>
				<div className="pw-trg-link pw-trg-link-out" aria-hidden="true">
					<span className="pw-packet">{artifact.packet}</span>
				</div>
				<div className="pw-node pw-trg-card pw-trg-outcome">
					<div className="pw-trg-head">
						<span className="pw-trg-tick" aria-hidden="true">
							✓
						</span>
						<span>
							<span className="pw-kicker">Result</span>
							<strong>{result}</strong>
						</span>
					</div>
					<div className="pw-trg-rows">
						<p>{artifact.kicker}</p>
						{artifact.lines.map((line) => (
							<p key={line}>{line}</p>
						))}
					</div>
					<span className="pw-trg-chip">{artifact.chip}</span>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
export function TriggerSignalsScene(props: { signal: SignalId; shot: number }) {
	const { signal, shot } = props
	const card = signalCard(signal)
	const chosen = signals[signal]
	return (
		<PrimitiveWidgetFrame
			id="triggers"
			size="full"
			height={signalHeight}
			className="pw-scene-trg-signals"
			stack
		>
			<div className="pw-run" key={`${signal}-${shot}`}>
				{wires(
					<>
						{signalRows.map((row) =>
							wire({
								key: row.id,
								d: signalWire(row.y),
								on: row.id === signal,
							}),
						)}
						{wire({
							key: 'down',
							d: 'M284 84 L284 132',
							on: true,
						})}
					</>,
					signalHeight,
				)}
				{signalRows.map((row) => (
					<div
						key={row.id}
						className="pw-node pw-trg-sig"
						data-on={row.id === signal ? '' : undefined}
						style={at(0, row.y)}
					>
						{signalMark(row.id)}
						<span>{row.label}</span>
					</div>
				))}
				<div className="pw-node pw-trg-card pw-trg-pkg" style={at(58, 22)}>
					<div className="pw-trg-head">
						<span className="pw-trg-fn" aria-hidden="true">
							ƒ
						</span>
						<span>
							<span className="pw-kicker">Saved code, ready to run</span>
							<strong>Your package</strong>
						</span>
					</div>
				</div>
				<div className="pw-node pw-trg-card pw-trg-sig-card" style={at(58, 68)}>
					<div className="pw-trg-head">
						<span>
							<span className="pw-kicker">{card.kicker}</span>
							<strong>{chosen.name}</strong>
						</span>
					</div>
					<div className="pw-trg-rows">
						{card.lines.map((line) => (
							<p key={line}>{line}</p>
						))}
					</div>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
export function TriggerScanScene(props: {
	flake: boolean
	result: ScanResult
	shot: number
}) {
	const { flake, result, shot } = props
	const lines = flake
		? [
				'scan(ci.since("24h"))',
				'brief.test.ts · flake',
				'return signal ?? quiet',
			]
		: [
				'scan(ci.since("24h"))',
				'if (run.flaky) signal = run',
				'return signal ?? quiet',
			]
	return (
		<PrimitiveWidgetFrame
			id="triggers"
			size="full"
			height={scanHeight}
			className="pw-scene-trg-scan"
			stack
		>
			<div
				className="pw-run"
				key={`${flake}-${result}-${shot}`}
				data-result={result}
			>
				{wires(
					<>
						{wire({
							key: 'clean',
							d: 'M180 140 L180 160 C180 180 79 176 79 192',
							on: result === 'clean',
						})}
						{wire({
							key: 'flake',
							d: 'M180 140 L180 160 C180 180 281 176 281 192',
							on: result === 'flake',
						})}
					</>,
					scanHeight,
				)}
				<div className="pw-node pw-trg-card pw-trg-scan" style={at(50, 32)}>
					<div className="pw-trg-head">
						<span className="pw-clock" aria-hidden="true"></span>
						<span>
							<span className="pw-kicker">04:00 · code</span>
							<strong>Scheduled scan</strong>
						</span>
						<span className="pw-trg-nomodel">No model</span>
					</div>
					<div className="pw-trg-code">
						<span className="pw-trg-scanbar" aria-hidden="true"></span>
						{lines.map((line, index) => (
							<p
								key={line}
								className="pw-trg-code-line"
								data-flake={flake && index === 1 ? '' : undefined}
							>
								<span aria-hidden="true">{index + 1}</span>
								{line}
							</p>
						))}
					</div>
				</div>
				<span className="pw-trg-ask">Signal?</span>
				<div
					className="pw-node pw-trg-card pw-trg-end pw-trg-clean"
					data-on={result === 'clean' ? '' : undefined}
					style={at(22, 80)}
				>
					<span className="pw-trg-check" aria-hidden="true">
						✓
					</span>
					<strong>Clean</strong>
					<p>No notification.</p>
				</div>
				<div
					className="pw-node pw-trg-card pw-trg-end pw-trg-flake"
					data-on={result === 'flake' ? '' : undefined}
					style={at(78, 80)}
				>
					<span
						className="pw-trg-agent"
						data-lit={result === 'flake' ? '' : undefined}
					>
						<span className="pw-trg-agent-dot" aria-hidden="true"></span>
						Agent
					</span>
					<strong>Flake found</strong>
					<p>Investigate.</p>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
