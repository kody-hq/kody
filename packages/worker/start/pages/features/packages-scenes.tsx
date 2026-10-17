/** @jsxImportSource @emotion/react */
import type { CSSProperties } from 'react'
import {
	at,
	PrimitiveWidgetFrame,
	wire,
	wires,
} from '../../components/primitive-widget-parts.tsx'
/**
 * `/features/packages` scenes. The page's own controls drive them; each
 * scene holds the visible example text, and `public/feature-scenes/packages.css`
 * animates it. A keyed `.pw-run` restarts the timeline on each click. The
 * still (no `data-motion`) is the finished end state.
 */
export type PackageTab = 'intent' | 'source' | 'result'
export type PackageAccess = 'use' | 'contribute' | 'manage'
export type PackageSharing = 'share' | 'fork'
/** `at()` plus the same spot as custom properties, so the page CSS can put
 *  a node back once the shared stack rules have overridden `left`/`top`. */
function place(x: number, y: number) {
	return at(x, y, { '--pkg-x': `${x}%`, '--pkg-y': `${y}%` })
}
function sequenceStyle(index: number): CSSProperties & { '--i': string } {
	return { '--i': String(index) }
}
const heroHeight = 196
const publishHeight = 348
const shareHeight = 300
const packageFiles = [
	'README.md',
	'AGENTS.md',
	'package.json',
	'src/brief.ts',
] as const
const briefSource = [
	'export function brief(week) {',
	'  return {',
	"    title: 'Weekly brief',",
	'    ...week,',
	'  }',
	'}',
] as const
const accessChips = [
	{ id: 'read', label: 'Read' },
	{ id: 'run', label: 'Run' },
	{ id: 'edit', label: 'Edit' },
	{ id: 'publish', label: 'Publish' },
	{ id: 'access', label: 'Access' },
] as const
type AccessChip = (typeof accessChips)[number]['id']
function chipLit(access: PackageAccess, chip: AccessChip) {
	switch (access) {
		case 'use':
			return chip === 'read' || chip === 'run'
		case 'contribute':
			return chip === 'read' || chip === 'run' || chip === 'edit'
		case 'manage':
			return true
		default: {
			const exhaustive: never = access
			return exhaustive
		}
	}
}
function accessLabel(access: PackageAccess) {
	switch (access) {
		case 'use':
			return 'Use'
		case 'contribute':
			return 'Contribute'
		case 'manage':
			return 'Manage'
		default: {
			const exhaustive: never = access
			return exhaustive
		}
	}
}
function renderBrief(question: boolean) {
	return (
		<>
			<h3>Weekly brief</h3>
			<p>
				Orchard: design review is ready.
				<br />
				Fieldwork: kickoff is booked.
			</p>
			{question ? (
				<p className="pw-pkg-question">
					Open question: Who approves the final copy?
				</p>
			) : null}
		</>
	)
}
export function PackageWorkbenchScene(props: {
	tab: PackageTab
	live: boolean
	shot: number
}) {
	const { tab, live, shot } = props
	return (
		<PrimitiveWidgetFrame
			id="packages"
			size="full"
			height={heroHeight}
			className="pw-scene-pkg-hero"
			stack
		>
			<div
				className="pw-run"
				key={`${tab}-${shot}-${live ? 'live' : 'base'}`}
				data-mode={tab}
				data-live={live ? '' : undefined}
			>
				{heroBody(tab, live)}
			</div>
		</PrimitiveWidgetFrame>
	)
}
function heroBody(tab: PackageTab, live: boolean) {
	switch (tab) {
		case 'intent':
			return (
				<>
					{wires(
						wire({ key: 'into', d: 'M168 98 L220 98', on: true }),
						heroHeight,
					)}
					<div
						className="pw-node pw-pkg-card pw-pkg-side pw-pkg-chat"
						style={place(2, 50)}
					>
						<span className="pw-kicker">Your agent</span>
						<p className="pw-pkg-ask">
							Collect the project updates I choose and turn them into a weekly
							brief.
						</p>
					</div>
					<div
						className="pw-node pw-pkg-card pw-pkg-side pw-pkg-born"
						style={place(62, 50)}
					>
						<span className="pw-pkg-card-head">
							<span className="pw-kicker pw-pkg-name">◇ weekly-brief</span>
							<span className="pw-pkg-badge">Published</span>
						</span>
						<ul className="pw-pkg-files">
							{packageFiles.map((file, index) => (
								<li key={file} style={sequenceStyle(index)}>
									{file}
								</li>
							))}
						</ul>
					</div>
				</>
			)
		case 'source':
			return (
				<>
					{wires(
						wire({ key: 'open', d: 'M115 98 L133 98', on: true }),
						heroHeight,
					)}
					<div
						className="pw-node pw-pkg-card pw-pkg-side pw-pkg-tree"
						style={place(2, 50)}
					>
						<span className="pw-kicker">weekly-brief</span>
						<ul className="pw-pkg-files">
							{packageFiles.map((file) => (
								<li
									key={file}
									data-on={file === 'src/brief.ts' ? '' : undefined}
								>
									{file}
								</li>
							))}
						</ul>
					</div>
					<div
						className="pw-node pw-pkg-card pw-pkg-side pw-pkg-editor"
						style={place(37, 50)}
					>
						<span className="pw-kicker">src/brief.ts</span>
						<code className="pw-pkg-code">
							{briefSource.map((line, index) => (
								<span
									key={index}
									className="pw-pkg-line"
									style={sequenceStyle(index)}
								>
									{line}
								</span>
							))}
						</code>
					</div>
				</>
			)
		case 'result':
			return (
				<>
					{wires(
						wire({ key: 'run', d: 'M144 98 L162 98', on: true }),
						heroHeight,
					)}
					<div
						className="pw-node pw-pkg-card pw-pkg-side pw-pkg-log"
						style={place(2, 50)}
					>
						<span className="pw-kicker">Run</span>
						<ol className="pw-pkg-loglines">
							<li style={sequenceStyle(0)}>› run weekly-brief</li>
							<li style={sequenceStyle(1)}>read src/brief.ts</li>
							<li style={sequenceStyle(2)}>wrote Weekly brief</li>
						</ol>
					</div>
					<div
						className="pw-node pw-pkg-card pw-pkg-side pw-pkg-result"
						style={place(45, 50)}
					>
						<span className="pw-kicker">Result</span>
						<div className="pw-pkg-brief">{renderBrief(live)}</div>
					</div>
				</>
			)
		default: {
			const exhaustive: never = tab
			return exhaustive
		}
	}
}
export function PackagePublishScene(props: {
	questions: boolean
	previewed: boolean
	previewQuestions: boolean
	live: boolean
	version: number
	shot: number
}) {
	const { questions, previewed, previewQuestions, live, version, shot } = props
	const proposedDiffers = previewed && previewQuestions !== live
	return (
		<PrimitiveWidgetFrame
			id="packages"
			size="full"
			height={publishHeight}
			className="pw-scene-pkg-publish"
			stack
		>
			<div
				className="pw-run pw-pkg-board"
				key={`${shot}-${version}-${previewed ? 'pre' : 'src'}-${questions ? 'q' : 'base'}`}
				data-acted={shot > 0 ? '' : undefined}
				data-preview={previewed ? '' : undefined}
				data-published={version > 1 ? '' : undefined}
				data-questions={questions ? '' : undefined}
			>
				<article className="pw-node pw-pkg-card pw-pkg-diff">
					<span className="pw-pkg-card-head">
						<span className="pw-kicker">Repo source · src/brief.ts</span>
					</span>
					<code className="pw-pkg-code">
						<span className="pw-pkg-line">
							export function brief(week) {'{'}
						</span>
						<span className="pw-pkg-line"> return format(week)</span>
						{questions ? (
							<span className="pw-pkg-line pw-pkg-add">
								+ openQuestion: 'Who approves the final copy?'
							</span>
						) : null}
						<span className="pw-pkg-line">{'}'}</span>
					</code>
				</article>
				<div className="pw-pkg-bridge" aria-hidden="true">
					<span className="pw-pkg-packet">preview</span>
				</div>
				<div className="pw-pkg-compare">
					{previewed ? (
						<article
							className="pw-node pw-pkg-card pw-pkg-out"
							data-diff={proposedDiffers ? '' : undefined}
						>
							<small>Proposed output</small>
							<div className="pw-pkg-brief">
								{renderBrief(previewQuestions)}
							</div>
						</article>
					) : (
						<article className="pw-node pw-pkg-card pw-pkg-out pw-pkg-wait">
							<small>Proposed output</small>
							<p>Preview the proposed change.</p>
						</article>
					)}
					<article className="pw-node pw-pkg-card pw-pkg-out pw-pkg-current">
						<small>Current published output</small>
						<div className="pw-pkg-brief">{renderBrief(live)}</div>
					</article>
				</div>
				<div className="pw-pkg-publish-step">
					<span className="pw-pkg-step-label">Publish</span>
					<div className="pw-pkg-bridge pw-pkg-bridge-pub" aria-hidden="true">
						<span className="pw-pkg-packet">runs</span>
					</div>
				</div>
				<article className="pw-node pw-pkg-card pw-pkg-runs">
					<span className="pw-pkg-card-head">
						<span className="pw-kicker">Runs here · weekly-brief</span>
						<span className="pw-pkg-badge" key={`v-${version}`}>
							v{version}
						</span>
					</span>
					<div className="pw-pkg-brief">{renderBrief(live)}</div>
				</article>
			</div>
		</PrimitiveWidgetFrame>
	)
}
export function PackageShareScene(props: {
	sharing: PackageSharing
	access: PackageAccess
	copyEdited: boolean
	shot: number
}) {
	const { sharing, access, copyEdited, shot } = props
	return (
		<PrimitiveWidgetFrame
			id="packages"
			size="full"
			height={shareHeight}
			className="pw-scene-pkg-share"
			stack
		>
			<div
				className="pw-run"
				key={`${sharing}-${access}-${copyEdited ? 'edit' : 'same'}-${shot}`}
				data-mode={sharing}
				data-access={access}
				data-edited={copyEdited ? '' : undefined}
			>
				{renderSharing(sharing, access, copyEdited)}
			</div>
		</PrimitiveWidgetFrame>
	)
}
function renderSharing(
	sharing: PackageSharing,
	access: PackageAccess,
	copyEdited: boolean,
) {
	switch (sharing) {
		case 'share':
			return renderShareDiagram(access)
		case 'fork':
			return renderForkDiagram(copyEdited)
		default: {
			const exhaustive: never = sharing
			return exhaustive
		}
	}
}
function renderShareDiagram(access: PackageAccess) {
	return (
		<>
			{wires(
				<>
					{wire({
						key: 'you',
						d: 'M180 102 C180 128 86 148 86 174',
						on: true,
					})}
					{wire({
						key: 'mate',
						d: 'M180 102 C180 128 274 148 274 174',
						on: true,
						i: 1,
					})}
				</>,
				shareHeight,
			)}
			<div className="pw-node pw-pkg-card pw-pkg-package" style={place(50, 34)}>
				<span className="pw-kicker">◇ weekly-brief</span>
				<strong>One live package</strong>
				<span className="pw-pkg-meta">Shared · runs in your organization</span>
			</div>
			<div className="pw-node pw-pkg-card pw-pkg-person" style={place(24, 58)}>
				<span className="pw-pkg-who">
					<span className="pw-pkg-avatar" aria-hidden="true">
						Y
					</span>
					You
				</span>
				<span className="pw-pkg-meta">Owner</span>
			</div>
			<div
				className="pw-node pw-pkg-card pw-pkg-person pw-pkg-mate"
				style={place(76, 58)}
			>
				<span className="pw-pkg-who">
					<span className="pw-pkg-avatar" aria-hidden="true">
						T
					</span>
					Teammate
				</span>
				<span className="pw-pkg-meta">{accessLabel(access)}</span>
				<ul className="pw-pkg-chips">
					{accessChips.map((chip, index) => (
						<li
							key={chip.id}
							className="pw-pkg-chip"
							data-on={chipLit(access, chip.id) ? '' : undefined}
							style={sequenceStyle(index)}
						>
							{chip.label}
						</li>
					))}
				</ul>
			</div>
		</>
	)
}
function renderForkDiagram(copyEdited: boolean) {
	return (
		<>
			{wires(
				<>
					{wire({
						key: 'keep',
						d: 'M180 48 C180 84 86 112 86 136',
						on: true,
					})}
					{wire({
						key: 'copy',
						d: 'M180 48 C180 84 274 112 274 136',
						on: true,
						i: 1,
					})}
				</>,
				shareHeight,
			)}
			<span className="pw-pkg-origin" style={place(50, 10)}>
				◇ weekly-brief · public
			</span>
			<div className="pw-node pw-pkg-card pw-pkg-copy" style={place(24, 52)}>
				<span className="pw-pkg-who">
					<span className="pw-pkg-avatar" aria-hidden="true">
						Y
					</span>
					You
				</span>
				<strong>Weekly brief</strong>
				<span className="pw-pkg-meta">Owner · project updates</span>
			</div>
			<div
				className="pw-node pw-pkg-card pw-pkg-copy pw-pkg-fork-copy"
				style={place(76, 52)}
				data-edited={copyEdited ? '' : undefined}
			>
				<span className="pw-pkg-who">
					<span className="pw-pkg-avatar" aria-hidden="true">
						T
					</span>
					Teammate
				</span>
				<strong className="pw-pkg-copy-title">
					{copyEdited ? 'Customer brief' : 'Weekly brief'}
				</strong>
				<span className="pw-pkg-meta">
					{copyEdited ? 'Owner · customer updates' : 'Owner · project updates'}
				</span>
			</div>
		</>
	)
}
