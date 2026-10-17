/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import { type Brief } from './apps-intake.tsx'
import { AppsShareScene, type AccessRole } from './apps-scenes.tsx'
const roles = {
	Use: 'Can read the source and run the package.',
	Contribute: 'Can read the source, run, and edit the package.',
	Manage:
		'Can read the source, run, edit, publish, delete, and manage access to the package.',
}
export function AppsSharing(props: { preview: Brief }) {
	const [role, setRole] = useState<AccessRole>('Use')
	const [shot, setShot] = useState(0)
	return (
		<section className="story-section">
			<div className="story-split">
				<div>
					<h2>
						Share the tool
						<br />
						you made.
					</h2>
					<p>
						Give someone access to the package behind your app. Choose whether
						they can run it, help build it, or manage it with you.
					</p>
					<SiteLink href="/docs/package-sharing">Share a package ↗</SiteLink>
				</div>
				<div className="ia-share-scene">
					<span className="example">Example package access</span>
					<div className="ia-collaborator">
						<span className="ia-avatar" aria-hidden="true">
							M
						</span>
						<div>
							<strong>Morgan</strong>
							<small>project-intake</small>
						</div>
						<label>
							<span className="ia-sr">Morgan’s access</span>
							<select
								value={role}
								onChange={(event) => {
									const next = event.currentTarget.value
									if (
										next === 'Use' ||
										next === 'Contribute' ||
										next === 'Manage'
									) {
										setRole(next)
										setShot((value) => value + 1)
									}
								}}
							>
								<option>Use</option>
								<option>Contribute</option>
								<option>Manage</option>
							</select>
						</label>
					</div>
					<p
						className="ia-role-description"
						id="ia-role-description"
						role="status"
					>
						{roles[role]}
					</p>
					<AppsShareScene role={role} brief={props.preview} shot={shot} />
					<p className="ia-note">
						Package access does not reveal secret values.
					</p>
				</div>
			</div>
		</section>
	)
}
