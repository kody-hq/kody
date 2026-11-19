import { useState, type ReactNode } from 'react'

export type FeatureExampleTab = {
	id: string
	label: string
	/** Read to screen readers when the tab is chosen. */
	summary: string
	code: string
}

/**
 * A titled example window with optional tabs, for feature pages whose
 * example is a prompt, a command, or a few lines of code.
 */
export function FeatureExample(props: {
	title: string
	state?: string
	tabsLabel?: string
	tabs: ReadonlyArray<FeatureExampleTab>
}) {
	const [selected, setSelected] = useState(props.tabs[0]!.id)
	const tab =
		props.tabs.find((entry) => entry.id === selected) ?? props.tabs[0]!
	return (
		<div className="ui-window fx-example">
			<div className="ui-title">
				<strong>{props.title}</strong>
				{props.state ? <span className="ui-state">{props.state}</span> : null}
			</div>
			{props.tabs.length > 1 ? (
				<div className="fx-tabs" aria-label={props.tabsLabel}>
					{props.tabs.map((entry) => (
						<button
							key={entry.id}
							type="button"
							aria-pressed={entry.id === tab.id}
							onClick={() => {
								setSelected(entry.id)
							}}
						>
							{entry.label}
						</button>
					))}
				</div>
			) : null}
			<pre className="fx-code">{tab.code}</pre>
			<p className="visually-hidden" aria-live="polite">
				{tab.summary}
			</p>
		</div>
	)
}

/** Says plainly when a feature is opt-in or early access. */
export function FeatureAvailability(props: { children: ReactNode }) {
	return <p className="fx-availability">{props.children}</p>
}
