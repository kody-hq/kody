/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { SiteLink } from '../../components/site-link.tsx'
import {
	SecretsDraftScene,
	SecretsVaultScene,
	type SecretSource,
} from './secrets-scenes.tsx'
export function SecretsVault() {
	const [source, setSource] = useState<SecretSource>('saved')
	const [shot, setShot] = useState(0)
	return (
		<section className="story-section">
			<div className="story-split ms-vault-split">
				<div className="ms-vault-scene">
					<SecretsVaultScene source={source} shot={shot} />
					<div className="controls" aria-label="Example credential source">
						<button
							type="button"
							aria-pressed={source === 'saved'}
							onClick={() => {
								setSource('saved')
								setShot((value) => value + 1)
							}}
						>
							Saved secret
						</button>
						<button
							type="button"
							aria-pressed={source === 'vault'}
							onClick={() => {
								setSource('vault')
								setShot((value) => value + 1)
							}}
						>
							Custom vault provider
						</button>
					</div>
					<p id="ms-source-copy" role="status">
						{source === 'vault'
							? 'A bound provider package retrieves the vault item for the request. Kody core does not connect directly to your vault.'
							: 'The agent uses a reference. Kody adds the credential to the outbound request.'}
					</p>
				</div>
				<div>
					<h2>
						The key can stay
						<br />
						in your vault.
					</h2>
					<p>
						Bind a custom secret provider to use vault items through the same
						request boundary. The agent works with a reference, and the model
						never sees the value.
					</p>
					<p>
						A 1Password provider is one documented example. It needs a
						configured package and an owner-created binding.
					</p>
					<SiteLink href="/docs/secret-providers">
						Set up a secret provider
					</SiteLink>
				</div>
			</div>
			<div className="ms-drafts">
				<div>
					<h3>Let it draft. Keep send out of reach.</h3>
					<p>
						Gmail's draft permission can also send. A drafts-only package, a
						publish lock, and an integration usage lock let your agent prepare
						replies through that package while you review and send in Gmail. The
						token's Google permissions stay the same.
					</p>
					<SiteLink href="/docs/locked-gmail-drafts">
						Build the drafts-only workflow
					</SiteLink>
				</div>
				<SecretsDraftScene />
			</div>
		</section>
	)
}
