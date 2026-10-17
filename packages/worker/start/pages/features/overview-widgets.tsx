/** @jsxImportSource @emotion/react */
import { PrimitiveWidgetFrame } from '../../components/primitive-widget-parts.tsx'
import { useState, type ReactNode } from 'react'
import {
	appPrompts,
	appsScene,
	type AppPromptId,
	integrationSlots,
	integrationsScene,
	type IntegrationSlotId,
	memoryAgents,
	memoryScene,
	type MemoryAgentId,
	packageCallers,
	packageChanges,
	packagesScene,
	type PackageCallerId,
	triggerSources,
	triggersScene,
	type TriggerSourceId,
} from '../../components/primitive-widgets.tsx'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'

/**
 * `/features` cards: the shared primitive scenes plus the controls that
 * drive them. Every control is a real button with a pressed state, and the
 * receipt under each scene is a polite live region that says what changed.
 */

function demo(options: {
	id: LandingPrimitiveId
	label: string
	scene: ReactNode
	controls?: ReactNode
	receipt: string
}) {
	return (
		<div className="demo" role="group" aria-label={options.label}>
			<PrimitiveWidgetFrame id={options.id} size="full">
				{options.scene}
			</PrimitiveWidgetFrame>
			{options.controls ? (
				<div className="demo-controls">{options.controls}</div>
			) : null}
			<p className="receipt" aria-live="polite">
				{options.receipt}
			</p>
		</div>
	)
}

function controlButton(options: {
	label: string
	pressed?: boolean
	onPress: () => void
}) {
	return (
		<button
			key={options.label}
			type="button"
			className="demo-control"
			aria-pressed={
				options.pressed === undefined
					? undefined
					: options.pressed
						? 'true'
						: 'false'
			}
			onClick={options.onPress}
		>
			{options.label}
		</button>
	)
}

function MemoryWidget() {
	const [agent, setAgent] = useState<MemoryAgentId>('cursor')
	const [shot, setShot] = useState(0)
	const name = memoryAgents.find((entry) => entry.id === agent)?.name
	return demo({
		id: 'memory',
		label: 'Memory example',
		scene: memoryScene({
			agent,
			shot,
			onAgent(id) {
				setAgent(id)
				setShot((value) => value + 1)
			},
		}),
		receipt:
			shot > 0
				? `${name} found your writing preference.`
				: 'Pick an agent. Each one finds the same saved preference.',
	})
}

function PackagesWidget() {
	const [version, setVersion] = useState(0)
	const [caller, setCaller] = useState<PackageCallerId>('claude')
	const [invoked, setInvoked] = useState(0)
	const name = packageCallers.find((entry) => entry.id === caller)?.name
	const release = `v1.${version + 2}`
	return demo({
		id: 'packages',
		label: 'Packages example',
		scene: packagesScene({
			version,
			caller,
			invoked,
			onCaller(id) {
				setCaller(id)
				setInvoked((value) => value + 1)
			},
		}),
		controls: controlButton({
			label: 'Publish a change',
			onPress() {
				setVersion((value) => value + 1)
				setInvoked(0)
			},
		}),
		receipt:
			invoked > 0
				? `${name} invoked weekly-brief ${release} and got this week's brief back.`
				: version > 0
					? `Published weekly-brief ${release} with ${packageChanges[(version - 1) % packageChanges.length]}. Pick an agent to invoke it.`
					: 'Write it once as a package. Then pick an agent to invoke it.',
	})
}

function TriggersWidget() {
	const [runs, setRuns] = useState(12)
	const [fired, setFired] = useState<TriggerSourceId | null>(null)
	const [shot, setShot] = useState(0)
	const source = triggerSources.find((entry) => entry.id === fired)
	return demo({
		id: 'triggers',
		label: 'Triggers example',
		scene: triggersScene({
			runs,
			fired,
			shot,
			onFire(id) {
				setFired(id)
				setRuns((value) => value + 1)
				setShot((value) => value + 1)
			},
		}),
		receipt: source
			? `${source.name} woke purchase-thanks. Run ${runs} finished without a chat open.`
			: 'Fire a trigger to wake the package.',
	})
}

function IntegrationsWidget() {
	const [booked, setBooked] = useState<IntegrationSlotId | null>(null)
	const [shot, setShot] = useState(0)
	const slot = integrationSlots.find((entry) => entry.id === booked)
	return demo({
		id: 'integrations',
		label: 'Credentials example',
		scene: integrationsScene({
			booked,
			shot,
			onBook(id) {
				setBooked(id)
				setShot((value) => value + 1)
			},
		}),
		controls: controlButton({
			label: 'Ask for times again',
			onPress() {
				setBooked(null)
				setShot((value) => value + 1)
			},
		}),
		receipt: slot
			? `Booked ${slot.label} on google-work. The request went out through Kody and the confirmation came back.`
			: 'meet-finder asked google-work for open times through Kody. Pick one to book it.',
	})
}

function AppsWidget() {
	const [prompt, setPrompt] = useState<AppPromptId>('intake')
	const [shot, setShot] = useState(0)
	const app = appPrompts.find((entry) => entry.id === prompt)
	return demo({
		id: 'apps',
		label: 'Apps example',
		scene: appsScene({ prompt, shot }),
		controls: (
			<>
				<span className="demo-controls-label">Ask for</span>
				{appPrompts.map((entry) =>
					controlButton({
						label: entry.label,
						pressed: prompt === entry.id,
						onPress() {
							setPrompt(entry.id)
							setShot((value) => value + 1)
						},
					}),
				)}
			</>
		),
		receipt:
			shot > 0
				? `Your agent turned “${app?.prompt}” into the ${app?.label} app.`
				: 'A prompt becomes an app you can open and share.',
	})
}

export function OverviewWidget({ id }: { id: LandingPrimitiveId }) {
	switch (id) {
		case 'memory':
			return <MemoryWidget />
		case 'packages':
			return <PackagesWidget />
		case 'triggers':
			return <TriggersWidget />
		case 'integrations':
			return <IntegrationsWidget />
		case 'apps':
			return <AppsWidget />
		default: {
			const unknown: never = id
			throw new Error(`Unknown primitive: ${String(unknown)}`)
		}
	}
}
