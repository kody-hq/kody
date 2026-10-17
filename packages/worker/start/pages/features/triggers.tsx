import { publicAsset } from '../../public-assets.ts'
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { BuildWithAgentButton } from '../../components/build-with-agent-button.tsx'
import { FeatureRelated } from './feature-related.tsx'
import {
	TriggerHeroScene,
	TriggerScanScene,
	TriggerSignalsScene,
	type ScanResult,
	type SignalId,
	type TriggerExampleId,
} from './triggers-scenes.tsx'
import { triggerExamples, signals } from './triggers-data.ts'
export function TriggersFeature() {
	const [selected, setSelected] = useState<TriggerExampleId>('purchase')
	const [signal, setSignal] = useState<SignalId>('webhook')
	const [ran, setRan] = useState(false)
	const [otherAddress, setOtherAddress] = useState(false)
	const [showFlake, setShowFlake] = useState(false)
	const [scanFlake, setScanFlake] = useState(false)
	const [scanResult, setScanResult] = useState<ScanResult>('')
	const [heroShot, setHeroShot] = useState(0)
	const [signalShot, setSignalShot] = useState(0)
	const [scanShot, setScanShot] = useState(0)
	const event = triggerExamples[selected]
	const result =
		selected === 'email' && otherAddress
			? 'No matching tag. No action.'
			: selected === 'schedule' && showFlake
				? 'Investigation started'
				: event.result
	const detail =
		selected === 'email' && otherAddress
			? 'No matching tag. No handler started.'
			: selected === 'schedule' && showFlake
				? 'Agent called after the scan found a signal.'
				: event.detail
	return (
		<div className="study triggers">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset(
							'/images/lantern/kody-primitives-orb-triggers.webp',
						)}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Give the next step
						<br />a starting signal.
					</h1>
					<p className="lead">
						A purchase lands. An issue opens. An email arrives. Your package
						runs, even when the chat is closed.
					</p>
					<SiteLink className="action" href="/onboarding">
						Connect your agent
					</SiteLink>
					<div className="controls trg-examples" aria-label="Example trigger">
						<button
							type="button"
							aria-pressed={selected === 'purchase'}
							onClick={() => {
								setSelected('purchase')
								setRan(false)
								setHeroShot((shot) => shot + 1)
							}}
						>
							A purchase
						</button>
						<button
							type="button"
							aria-pressed={selected === 'issue'}
							onClick={() => {
								setSelected('issue')
								setRan(false)
								setHeroShot((shot) => shot + 1)
							}}
						>
							An issue
						</button>
						<button
							type="button"
							aria-pressed={selected === 'email'}
							onClick={() => {
								setSelected('email')
								setRan(false)
								setHeroShot((shot) => shot + 1)
							}}
						>
							An email
						</button>
						<button
							type="button"
							aria-pressed={selected === 'schedule'}
							onClick={() => {
								setSelected('schedule')
								setRan(false)
								setHeroShot((shot) => shot + 1)
							}}
						>
							A daily check
						</button>
					</div>
					<div className="controls trg-run">
						{selected === 'email' && (
							<label>
								<input
									type="checkbox"
									checked={otherAddress}
									onChange={(event) => {
										setOtherAddress(event.currentTarget.checked)
										setRan(false)
										setHeroShot((shot) => shot + 1)
									}}
								/>{' '}
								Use another address
							</label>
						)}
						{selected === 'schedule' && (
							<label>
								<input
									type="checkbox"
									checked={showFlake}
									onChange={(event) => {
										setShowFlake(event.currentTarget.checked)
										setRan(false)
										setHeroShot((shot) => shot + 1)
									}}
								/>{' '}
								Show a flake
							</label>
						)}
						<button
							type="button"
							className="run"
							onClick={() => {
								setRan(true)
								setHeroShot((shot) => shot + 1)
							}}
						>
							Run example
						</button>
					</div>
					<p className="result" id="trigger-detail" aria-live="polite">
						{ran ? detail : 'Run the example to follow the event.'}
					</p>
				</div>
				<div className="trg-hero-scene">
					<TriggerHeroScene
						example={selected}
						result={result}
						otherAddress={otherAddress}
						showFlake={showFlake}
						shot={heroShot}
					/>
					<p className="smallprint">
						Illustrative events. Ordinary code can do the watching and call an
						agent when needed.
					</p>
				</div>
			</div>
			<section className="story-section story-split pt-signals">
				<div>
					<h2>
						Use the signal
						<br />
						you already have.
					</h2>
					<p>
						Your tools, inbox, packages, and schedule can each start the next
						piece of work.
					</p>
					<div className="pt-signal-list" aria-label="Starting signal">
						<button
							type="button"
							aria-pressed={signal === 'webhook'}
							onClick={() => {
								setSignal('webhook')
								setSignalShot((shot) => shot + 1)
							}}
						>
							<strong>Your tools can call it.</strong>
							<span>A system sends a webhook.</span>
						</button>
						<button
							type="button"
							aria-pressed={signal === 'inbox'}
							onClick={() => {
								setSignal('inbox')
								setSignalShot((shot) => shot + 1)
							}}
						>
							<strong>Your inbox can start it.</strong>
							<span>Route mail by sender or plus-tag.</span>
						</button>
						<button
							type="button"
							aria-pressed={signal === 'package'}
							onClick={() => {
								setSignal('package')
								setSignalShot((shot) => shot + 1)
							}}
						>
							<strong>Your packages can pass it on.</strong>
							<span>React to an event in your account.</span>
						</button>
						<button
							type="button"
							aria-pressed={signal === 'clock'}
							onClick={() => {
								setSignal('clock')
								setSignalShot((shot) => shot + 1)
							}}
						>
							<strong>The clock works too.</strong>
							<span>Run on a schedule or later.</span>
						</button>
					</div>
					<SiteLink href="/docs/triggers">Read the trigger guide ↗</SiteLink>
				</div>
				<div className="pt-switch-illustration">
					<TriggerSignalsScene signal={signal} shot={signalShot} />
					<div className="pt-signal-outcome" aria-live="polite">
						<strong>{signals[signal].name}</strong>
						<p id="pt-signal-detail">{signals[signal].detail}</p>
						<SiteLink href={signals[signal].href}>
							How this signal works ↗
						</SiteLink>
					</div>
				</div>
			</section>
			<section className="story-section story-split pt-watching">
				<div>
					<h2>
						Let code do
						<br />
						the watching.
					</h2>
					<p>
						A trigger starts your package without a model deciding whether to
						run it. The package can call an agent when the work needs one.
					</p>
					<div className="pt-options">
						<label>
							<input
								type="checkbox"
								checked={scanFlake}
								onChange={(event) => {
									setScanFlake(event.currentTarget.checked)
									setScanResult('')
									setScanShot((shot) => shot + 1)
								}}
							/>{' '}
							Include a flaky test in this example
						</label>
						<button
							type="button"
							onClick={() => {
								setScanResult(scanFlake ? 'flake' : 'clean')
								setScanShot((shot) => shot + 1)
							}}
						>
							Run example scan
						</button>
					</div>
					<p id="pt-scan-result" className="pt-status" aria-live="polite">
						{scanResult === 'flake'
							? 'Flake found. The example package calls an agent to investigate.'
							: scanResult === 'clean'
								? 'Scan complete. No flakes found, no agent called, no notification.'
								: 'A clean scan can end with no notification.'}
					</p>
					<SiteLink href="/docs/flake-hunter">
						See how Flake Hunter works ↗
					</SiteLink>
				</div>
				<div className="pt-decision" data-result={scanResult}>
					<TriggerScanScene
						flake={scanFlake}
						result={scanResult}
						shot={scanShot}
					/>
					<p className="pt-example-caption">
						Example scan. An agent is called only on the branch that needs
						investigation.
					</p>
				</div>
			</section>
			<FeatureRelated
				links={[
					{ href: '/features/packages', label: 'Reusable packages' },
					{ href: '/features/apps', label: 'Package apps' },
					{ href: '/features/credentials', label: 'Credentials' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>Test it before you leave it running.</h2>
					<p>
						Run the handler once and check the result. Follow recent runs and
						failures in Activity.
					</p>
					<p>
						<SiteLink href="/docs/triggers">Read the guide</SiteLink>
					</p>
				</div>
				<div className="controls">
					<SiteLink className="action" href="/onboarding">
						Connect your agent
					</SiteLink>
					<BuildWithAgentButton />
				</div>
			</div>
		</div>
	)
}
