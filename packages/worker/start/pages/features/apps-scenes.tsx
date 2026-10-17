/** @jsxImportSource @emotion/react */
import { type ReactNode } from 'react'
import {
	icon,
	PrimitiveWidgetFrame,
} from '../../components/primitive-widget-parts.tsx'
import { type Brief } from './apps-intake.tsx'
/**
 * `/features/apps` scenes. The page's own controls drive them. A keyed
 * `.pw-run` replays a story on each click. The intake fields stay outside
 * those runs so typing never restarts an animation. Every stage sizes to its
 * content (`apps.css`) and stacks on narrow containers.
 */
export const tomorrowBrief = {
	name: 'Launch checklist',
	kind: 'Campaign',
	deadline: 'November 4',
} as const
function appChrome(badge: string) {
	return (
		<div className="pw-apx-chrome">
			<span className="pw-apx-dots" aria-hidden="true"></span>
			<span className="pw-apx-url">kody.app/project-intake</span>
			<span className="pw-apx-demo">{badge}</span>
		</div>
	)
}
export function AppsHeroScene(props: {
	promptShot: number
	saveShot: number
	count: number
	flyingName: string
	formPressed: boolean
	recordsPressed: boolean
	onShowForm: () => void
	onShowRecords: () => void
	children?: ReactNode
}) {
	const {
		promptShot,
		saveShot,
		count,
		flyingName,
		formPressed,
		recordsPressed,
		children,
	} = props
	return (
		<PrimitiveWidgetFrame
			id="apps"
			size="full"
			className="pw-scene-apx-hero"
			stack
		>
			<div className="pw-apx-shell">
				<div className="pw-run pw-apx-prompt-run" key={`prompt-${promptShot}`}>
					<div className="pw-apx-prompt-row">
						<div className="pw-apx-prompt">
							<span className="pw-apx-prompt-head">
								{icon('cursor')}
								Your agent
							</span>
							<p className="pw-apx-prompt-text">
								Make me a project intake form
							</p>
						</div>
						<span className="pw-apx-hosted">Hosted</span>
					</div>
				</div>
				<div className="pw-apx-lane" aria-hidden="true">
					<span className="pw-apx-packet">build</span>
				</div>
				<div className="pw-apx-window">
					{appChrome('Demo app')}
					<div id="intake-demo">
						<div className="pw-apx-tabs" aria-label="Demo views">
							<button
								type="button"
								className="pw-apx-tab"
								aria-pressed={formPressed}
								onClick={() => {
									props.onShowForm()
								}}
							>
								Intake form
							</button>
							<button
								type="button"
								className="pw-apx-tab"
								aria-pressed={recordsPressed}
								onClick={() => {
									props.onShowRecords()
								}}
							>
								Saved briefs
								<span className="pw-apx-badge-wrap">
									<span
										className="pw-apx-badge"
										key={saveShot}
										data-pop={saveShot > 0 ? '' : undefined}
									>
										{count}
									</span>
									{saveShot > 0 ? (
										<span
											className="pw-apx-fly"
											key={`fly-${saveShot}`}
											aria-hidden="true"
										>
											<strong>{flyingName}</strong>
											<small>Saved</small>
										</span>
									) : null}
								</span>
							</button>
						</div>
						<div className="pw-apx-body">{children}</div>
					</div>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
function keptMark() {
	return (
		<svg className="pw-apx-check" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M3 8.5 6.5 12 13 4" />
		</svg>
	)
}
function dayCard(brief: Brief, opened: boolean) {
	return (
		<div className="pw-apx-card" data-on={opened ? '' : undefined}>
			<span className="pw-apx-card-top">
				<strong>{brief.name}</strong>
			</span>
			<small>
				{brief.kind} · {brief.deadline}
			</small>
		</div>
	)
}
export function AppsReturnScene(props: {
	records: ReadonlyArray<Brief>
	openedId?: number
}) {
	const { records, openedId } = props
	const shown = records.slice(0, 2)
	const extra = records.length - shown.length
	const signature = records
		.map((record) => `${record.id}:${record.name}`)
		.join('|')
	return (
		<PrimitiveWidgetFrame
			id="apps"
			size="full"
			className="pw-scene-apx-return"
			stack
		>
			<div className="pw-run" key={`${signature}-${openedId ?? 'none'}`}>
				<div className="pw-apx-window pw-apx-window-fill">
					{appChrome('Saved briefs')}
					<div className="pw-apx-cal">
						<div className="pw-apx-col">
							<span className="pw-apx-dayhead">Today</span>
							{shown.map((brief) => (
								<div key={`today-${brief.id}`}>
									{dayCard(brief, brief.id === openedId)}
								</div>
							))}
							{extra > 0 ? (
								<small className="pw-apx-more">+{extra} more</small>
							) : null}
						</div>
						<div className="pw-apx-col pw-apx-col-next">
							<span className="pw-apx-dayhead">
								Tomorrow
								<span className="pw-apx-cursor" aria-hidden="true"></span>
							</span>
							{shown.map((brief, index) => (
								<div
									className="pw-apx-card"
									key={`next-${brief.id}`}
									data-on={brief.id === openedId ? '' : undefined}
								>
									<span className="pw-apx-card-top">
										<strong>{brief.name}</strong>
										{index === 0 ? (
											<span className="pw-apx-kept" aria-hidden="true"></span>
										) : null}
										{keptMark()}
									</span>
									<small>
										{brief.kind} · {brief.deadline}
									</small>
								</div>
							))}
							<div className="pw-apx-card pw-apx-card-new">
								<span className="pw-apx-card-top">
									<strong>{tomorrowBrief.name}</strong>
									<span className="pw-apx-newtag">New</span>
								</span>
								<small>
									{tomorrowBrief.kind} · {tomorrowBrief.deadline}
								</small>
							</div>
							{extra > 0 ? (
								<small className="pw-apx-more">+{extra} more</small>
							) : null}
						</div>
					</div>
					<p className="pw-apx-foot">Saved with the package</p>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
export type AccessRole = 'Use' | 'Contribute' | 'Manage'
function fillFor(role: AccessRole) {
	switch (role) {
		case 'Use':
			return '0.08'
		case 'Contribute':
			return '0.5'
		case 'Manage':
			return '1'
		default: {
			const unknown: never = role
			throw new Error(`Unknown access: ${String(unknown)}`)
		}
	}
}
function morganSheet(role: AccessRole, brief: Brief) {
	switch (role) {
		case 'Use':
			return (
				<div className="pw-apx-sheet">
					<span className="pw-kicker">Read only</span>
					<strong className="pw-apx-sheet-title">{brief.name}</strong>
					<p>
						{brief.kind} · {brief.deadline}
					</p>
					<p className="pw-apx-copy">{brief.copy}</p>
					<span className="pw-apx-action">
						Run
						<span className="pw-apx-cursor" aria-hidden="true"></span>
					</span>
					<span className="pw-apx-toast">Ran project-intake</span>
				</div>
			)
		case 'Contribute':
			return (
				<div className="pw-apx-sheet">
					<span className="pw-kicker">Can edit</span>
					<span className="pw-apx-field">
						<span>Project</span>
						<span className="pw-apx-value">{brief.name}</span>
					</span>
					<span className="pw-apx-field">
						<span>Job</span>
						<span className="pw-apx-value">{brief.kind}</span>
					</span>
					<span className="pw-apx-action">
						Edit
						<span className="pw-apx-cursor" aria-hidden="true"></span>
					</span>
					<span className="pw-apx-toast">Editing the package</span>
				</div>
			)
		case 'Manage':
			return (
				<div className="pw-apx-sheet">
					<span className="pw-kicker">Manage</span>
					<span className="pw-apx-field">
						<span>Project</span>
						<span className="pw-apx-value">{brief.name}</span>
					</span>
					<span className="pw-apx-actions">
						<span className="pw-apx-action pw-apx-action-quiet">Edit</span>
						<span className="pw-apx-action">
							Publish
							<span className="pw-apx-cursor" aria-hidden="true"></span>
						</span>
					</span>
					<p className="pw-apx-access">Access · Morgan · Manage</p>
					<span className="pw-apx-toast">Published · access updated</span>
				</div>
			)
		default: {
			const unknown: never = role
			throw new Error(`Unknown access: ${String(unknown)}`)
		}
	}
}
export function AppsShareScene(props: {
	role: AccessRole
	brief: Brief
	shot: number
}) {
	const { role, brief, shot } = props
	return (
		<PrimitiveWidgetFrame
			id="apps"
			size="full"
			className="pw-scene-apx-share"
			stack
		>
			<div
				className="pw-run"
				key={`${role}-${shot}-${brief.name}`}
				data-role={role}
			>
				<div className="pw-apx-track">
					<span className="pw-apx-track-line" aria-hidden="true"></span>
					<span
						className="pw-apx-track-fill"
						aria-hidden="true"
						css={{ '--pw-apx-fill': fillFor(role) }}
					></span>
					<span className="pw-apx-step" data-on="">
						<span className="pw-apx-dot" aria-hidden="true"></span>
						Read + run
					</span>
					<span
						className="pw-apx-step"
						data-on={role === 'Use' ? undefined : ''}
					>
						<span className="pw-apx-dot" aria-hidden="true"></span>
						Edit
					</span>
					<span
						className="pw-apx-step"
						data-on={role === 'Manage' ? '' : undefined}
					>
						<span className="pw-apx-dot" aria-hidden="true"></span>
						Publish + access
					</span>
				</div>
				<div className="pw-apx-window pw-apx-window-fill">
					{appChrome('Morgan')}
					<p className="pw-apx-view-label">Morgan’s view</p>
					{morganSheet(role, brief)}
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
