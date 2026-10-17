/** @jsxImportSource @emotion/react */
import { publicAsset } from '../../public-assets.ts'
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { BuildWithAgentButton } from '../../components/build-with-agent-button.tsx'
import { FeatureRelated } from './feature-related.tsx'
import {
	PackagePublishScene,
	PackageShareScene,
	PackageWorkbenchScene,
	type PackageAccess,
	type PackageSharing,
	type PackageTab,
} from './packages-scenes.tsx'
const examplePackageSource = 'README.md\nAGENTS.md\npackage.json\nsrc/brief.ts'
const packageTabs = ['Intent', 'Source', 'Result'] as const
type PackageTabLabel = (typeof packageTabs)[number]
function tabFromLabel(label: PackageTabLabel): PackageTab {
	switch (label) {
		case 'Intent':
			return 'intent'
		case 'Source':
			return 'source'
		case 'Result':
			return 'result'
		default: {
			const exhaustive: never = label
			return exhaustive
		}
	}
}
function tabStatus(tab: PackageTab) {
	switch (tab) {
		case 'intent':
			return 'Showing the request that became the weekly-brief package.'
		case 'source':
			return 'Showing the package source in src/brief.ts.'
		case 'result':
			return 'Showing the result of running weekly-brief.'
		default: {
			const exhaustive: never = tab
			return exhaustive
		}
	}
}
function accessFromValue(value: string): PackageAccess {
	switch (value) {
		case 'use':
		case 'contribute':
		case 'manage':
			return value
		default:
			return 'use'
	}
}
export function PackagesFeature() {
	const [tab, setTab] = useState<PackageTab>('intent')
	const [heroShot, setHeroShot] = useState(0)
	const [questions, setQuestions] = useState(false)
	const [previewQuestions, setPreviewQuestions] = useState(false)
	const [previewed, setPreviewed] = useState(false)
	const [live, setLive] = useState(false)
	const [publishShot, setPublishShot] = useState(0)
	const [version, setVersion] = useState(1)
	const [sharing, setSharing] = useState<PackageSharing>('share')
	const [access, setAccess] = useState<PackageAccess>('use')
	const [copyEdited, setCopyEdited] = useState(false)
	const [forkArtStatus, setForkArtStatus] = useState('')
	const [shareShot, setShareShot] = useState(0)
	const [status, setStatus] = useState(
		'Example package. The published brief has no open questions.',
	)
	return (
		<div className="study packages">
			<div className="split">
				<div>
					<img
						className="feature-orb"
						src={publicAsset(
							'/images/lantern/kody-primitives-orb-packages.webp',
						)}
						alt=""
						width="80"
						height="80"
					/>
					<h1>
						Keep the software
						<br />
						<em>your agent builds.</em>
					</h1>
					<p className="lead">
						Turn a useful one-off into a package you own. Run it again, change
						it, or give someone access to the work.
					</p>
					<div className="controls">
						<SiteLink className="action" href="/onboarding">
							Connect your agent
						</SiteLink>
						<SiteLink href="/community">Explore community packages</SiteLink>
					</div>
				</div>
				<div>
					<span className="example">Illustrative package workbench</span>
					<div className="bench ui-window">
						<div className="spine">
							<span>
								<span className="ui-symbol">◇</span> weekly-brief
							</span>
							<span className="ui-state">Published</span>
						</div>
						<div className="controls" aria-label="Package contents">
							{packageTabs.map((label) => {
								const next = tabFromLabel(label)
								return (
									<button
										key={label}
										type="button"
										aria-pressed={tab === next}
										onClick={() => {
											setTab(next)
											setHeroShot((value) => value + 1)
										}}
									>
										{label}
									</button>
								)
							})}
						</div>
						<p className="visually-hidden" aria-live="polite">
							{tabStatus(tab)}
						</p>
						<div className="contents" id="package-content">
							<PackageWorkbenchScene tab={tab} live={live} shot={heroShot} />
							{tab === 'source' ? (
								<SiteLink className="pw-pkg-skills" href="/docs/package-skills">
									Packages can also include Agent Skills
								</SiteLink>
							) : null}
						</div>
						{/* Tab panels need JS; keep example source readable without it. */}
						<noscript>
							<div className="contents" id="package-source-fallback">
								<small>Example source</small>
								<pre>{examplePackageSource}</pre>
							</div>
						</noscript>
						<div className="stamp">
							<small id="publish-state">Current published code</small>
							<SiteLink href="#package-publishing">
								Try a source change ↓
							</SiteLink>
						</div>
					</div>
				</div>
			</div>
			<section
				className="story-section story-split pt-publish"
				id="package-publishing"
			>
				<div>
					<h2>
						Change the source.
						<br />
						Choose when it runs.
					</h2>
					<p>
						Your package has a repo. Your agent can edit the source and check
						the result. Publishing makes that change the code your package runs.
					</p>
					<div className="pt-options">
						<label>
							<input
								type="checkbox"
								checked={questions}
								onChange={(event) => {
									setQuestions(event.currentTarget.checked)
									setPreviewed(false)
									setPublishShot((value) => value + 1)
									setStatus(
										'Source changed. Preview it to compare with the current published output.',
									)
								}}
							/>{' '}
							Include open questions
						</label>
						<button
							type="button"
							onClick={() => {
								setPreviewed(true)
								setPreviewQuestions(questions)
								setPublishShot((value) => value + 1)
								setStatus(
									questions
										? 'Example output includes open questions. The published output has not changed.'
										: 'Example output has no open questions. The published output has not changed.',
								)
							}}
						>
							Preview proposed change
						</button>
						<button
							type="button"
							disabled={!previewed || questions === live}
							onClick={() => {
								setLive(questions)
								setVersion((value) => value + 1)
								setPublishShot((value) => value + 1)
								setStatus('Example change is now published.')
							}}
						>
							Publish example change
						</button>
					</div>
					<p id="pt-publish-status" className="pt-status" aria-live="polite">
						{status}
					</p>
					<SiteLink href="/docs/package-authoring">
						How packages are built ↗
					</SiteLink>
				</div>
				<div className="pt-proof">
					<PackagePublishScene
						questions={questions}
						previewed={previewed}
						previewQuestions={previewQuestions}
						live={live}
						version={version}
						shot={publishShot}
					/>
				</div>
			</section>
			<section className="story-section story-split pt-sharing">
				<div>
					<h2>
						Share the work.
						<br />
						Or hand over a copy.
					</h2>
					<p>
						Give someone access to one live package. Fork a public package when
						they should own and change their own copy.
					</p>
					<div className="controls">
						<button
							type="button"
							aria-pressed={sharing === 'share'}
							onClick={() => {
								setSharing('share')
								setShareShot((value) => value + 1)
							}}
						>
							Share access
						</button>
						<button
							type="button"
							aria-pressed={sharing === 'fork'}
							onClick={() => {
								setSharing('fork')
								setShareShot((value) => value + 1)
							}}
						>
							Make a copy
						</button>
					</div>
					<div hidden={sharing === 'fork'}>
						<label htmlFor="pt-access">Access level</label>
						<select
							id="pt-access"
							value={access}
							onChange={(event) => {
								setAccess(accessFromValue(event.currentTarget.value))
								setShareShot((value) => value + 1)
							}}
						>
							<option value="use">Use: read and run</option>
							<option value="contribute">
								Contribute: read, run, and edit
							</option>
							<option value="manage">
								Manage: edit, publish, delete, and manage access
							</option>
						</select>
					</div>
					<button
						type="button"
						hidden={sharing !== 'fork'}
						onClick={() => {
							setCopyEdited(!copyEdited)
							setForkArtStatus('Change the copy’s focus')
							setShareShot((value) => value + 1)
						}}
					>
						Change the copy’s focus
					</button>
					<p className="visually-hidden" aria-live="polite">
						{forkArtStatus}
					</p>
					<p id="pt-share-status" className="pt-status" aria-live="polite">
						{sharing === 'fork'
							? 'Two owners, two separate packages. Changes to the copy are its owner’s to make.'
							: access === 'manage'
								? 'They can read, run, edit, publish, delete, and manage access. Runs stay in the owner’s organization.'
								: access === 'contribute'
									? 'They can read, run, and edit the same package. Runs stay in the owner’s organization.'
									: 'They can read the source and run the same package. Runs stay in the owner’s organization.'}
					</p>
					<SiteLink href="/docs/package-sharing">
						Package sharing and access ↗
					</SiteLink>
				</div>
				<div className="pt-share-art">
					<PackageShareScene
						sharing={sharing}
						access={access}
						copyEdited={copyEdited}
						shot={shareShot}
					/>
				</div>
			</section>
			<FeatureRelated
				links={[
					{ href: '/features/triggers', label: 'Triggers and automation' },
					{ href: '/features/apps', label: 'Package apps' },
					{ href: '/features/credentials', label: 'Credentials' },
				]}
			/>
			<div className="feature-start">
				<div>
					<h2>Start with work you already repeat.</h2>
					<p>
						Keep a reporting tool, a recurring check, or a small app as software
						you can use again.
					</p>
					<p>
						<SiteLink href="/docs/package-lifecycle">Read the guide</SiteLink>
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
