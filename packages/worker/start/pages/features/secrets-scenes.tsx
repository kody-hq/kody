/** @jsxImportSource @emotion/react */
import {
	at,
	icon,
	PrimitiveWidgetFrame,
	wire,
	wires,
} from '../../components/primitive-widget-parts.tsx'
/**
 * `/features/credentials` safety scenes. The page's buttons drive them; each scene
 * holds the visible example, and `public/feature-scenes/secrets.css`
 * animates it. A keyed `.pw-run` restarts the timeline on every click.
 * Status text that screen readers hear stays outside `.pw-run`, because
 * that node remounts.
 *
 * Cards are placed by their top-left corner and sized in the page CSS, so
 * wire endpoints below line up with card edges at every stage width.
 */
const secretRef = '{{secret:stripe}}'
const attachedKey = 'Bearer sk_••••4f2a'
export type SecretHost = 'approved' | 'blocked'
const tripHeight = 236
function hostName(host: SecretHost) {
	switch (host) {
		case 'approved':
			return 'api.stripe.com'
		case 'blocked':
			return 'paste.example'
		default: {
			const never: never = host
			return never
		}
	}
}
function destinationLabel(host: SecretHost) {
	switch (host) {
		case 'approved':
			return 'Approved API host'
		case 'blocked':
			return 'Unapproved host'
		default: {
			const never: never = host
			return never
		}
	}
}
export function tripResultCopy(host: SecretHost, sent: boolean) {
	if (!sent) return 'Ready to send an example request.'
	switch (host) {
		case 'approved':
			return 'Request sent to the approved host.'
		case 'blocked':
			return 'Blocked. This host is not approved.'
		default: {
			const never: never = host
			return never
		}
	}
}
function authStatus(host: SecretHost, sent: boolean) {
	if (!sent) return 'Ready — waiting for a request'
	switch (host) {
		case 'approved':
			return 'Added at request boundary'
		case 'blocked':
			return 'Not sent — key withheld'
		default: {
			const never: never = host
			return never
		}
	}
}
function bearerLine(host: SecretHost, sent: boolean) {
	if (!sent) return 'no key attached yet'
	switch (host) {
		case 'approved':
			return attachedKey
		case 'blocked':
			return 'nothing attached'
		default: {
			const never: never = host
			return never
		}
	}
}
function httpLines(host: SecretHost, sent: boolean) {
	if (!sent) return ['No response yet']
	switch (host) {
		case 'approved':
			return ['200 OK', 'ch_3Qx8k2eL', '$42.00 paid']
		case 'blocked':
			return ['0 bytes sent', 'nothing left']
		default: {
			const never: never = host
			return never
		}
	}
}
export function SecretsTripScene(props: {
	host: SecretHost
	sent: boolean
	shot: number
}) {
	const { host, sent, shot } = props
	const blocked = host === 'blocked'
	const name = hostName(host)
	const release = sent && !blocked
	const y = (percent: number) => Math.round((percent / 100) * tripHeight)
	return (
		<PrimitiveWidgetFrame
			id="secrets"
			size="full"
			height={tripHeight}
			className="pw-scene-sec-trip"
			stack
		>
			<div
				className="pw-run"
				key={`${host}-${sent ? 'sent' : 'ready'}-${shot}`}
				data-host={host}
				data-sent={sent ? '' : undefined}
				data-blocked={sent && blocked ? '' : undefined}
			>
				{wires(
					<>
						{wire({
							key: 'ref',
							d: `M77 ${y(47)} L77 ${y(57)}`,
							on: true,
						})}
						{wire({
							key: 'out',
							d: `M155 ${y(78.5)} L205 ${y(78.5)}`,
							on: release,
						})}
					</>,
					tripHeight,
				)}
				<div className="pw-node pw-sec-card pw-sec-agent" style={at(0, 0)}>
					<div className="pw-sec-head">
						{icon('claude')}
						<strong>Agent sees</strong>
					</div>
					<p className="pw-sec-ask">Charge invoice 2041.</p>
					<span className="pw-sec-k">
						POST <b className="pw-sec-host-name">{name}</b>
					</span>
					<code className="pw-sec-ref pw-sec-live">{secretRef}</code>
					<span className="pw-sec-mask">
						<code>sk_••••••••</code>
						<small>masked</small>
					</span>
				</div>
				<span
					className="pw-sec-chip pw-sec-chip-ref"
					style={at(21.5, 52)}
					aria-hidden="true"
				>
					{secretRef}
				</span>
				<div className="pw-node pw-sec-card pw-sec-kody" style={at(0, 57)}>
					<div className="pw-sec-head">
						<span className="pw-lock" aria-hidden="true"></span>
						<strong>Kody host allowlist</strong>
					</div>
					<span
						className="pw-sec-rule"
						data-on={!blocked ? '' : undefined}
						data-verdict="pass"
					>
						<span>api.stripe.com</span>
						<b>✓</b>
					</span>
					<span className="pw-sec-rule">
						<span>api.example.com</span>
						<b>✓</b>
					</span>
					<span
						className="pw-sec-rule"
						data-on={blocked ? '' : undefined}
						data-verdict="fail"
					>
						<span>paste.example</span>
						<b>✕</b>
					</span>
				</div>
				<span className="pw-sec-out" style={at(50, 78.5)} aria-hidden="true">
					{release ? (
						<span className="pw-sec-chip pw-sec-lane-key">key</span>
					) : sent ? (
						<span className="pw-sec-stamp">✕</span>
					) : (
						<span className="pw-sec-out-idle">↓</span>
					)}
				</span>
				<div className="pw-node pw-sec-card pw-sec-host" style={at(57, 0)}>
					<div className="pw-sec-head">
						{blocked ? (
							<span className="pw-sec-deny" aria-hidden="true">
								✕
							</span>
						) : (
							icon('stripe')
						)}
						<strong id="destination">{destinationLabel(host)}</strong>
					</div>
					<span className="pw-sec-host-name">{name}</span>
					<span className="pw-sec-k">Authorization</span>
					<span id="ui-auth-status" className="pw-sec-auth">
						{authStatus(host, sent)}
					</span>
					<code className="pw-sec-bearer">{bearerLine(host, sent)}</code>
					<p className="pw-sec-http">
						{httpLines(host, sent).map((line) => (
							<span key={line}>{line}</span>
						))}
					</p>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
export type SecretApproval = 'host' | 'package' | 'expiry'
const accessHeight = 180
const accessRows: Record<
	SecretApproval,
	{
		label: string
		value: string
		verdict: 'pass' | 'fail'
	}
> = {
	host: {
		label: 'Allowed host',
		value: 'api.example.com',
		verdict: 'pass',
	},
	package: {
		label: 'Package',
		value: 'weekly-brief',
		verdict: 'pass',
	},
	expiry: {
		label: 'Expiry',
		value: 'Checked before use',
		verdict: 'fail',
	},
}
function accessRequest(approval: SecretApproval) {
	switch (approval) {
		case 'host':
			return {
				title: 'POST /v1/charges',
				detail: 'api.example.com',
				note: 'Host is on the allowlist',
			}
		case 'package':
			return {
				title: 'weekly-brief',
				detail: 'Authored by you',
				note: 'Use is automatic',
			}
		case 'expiry':
			return {
				title: 'stripe',
				detail: 'Expired 2 Mar 2026',
				note: 'Listed, not resolved',
			}
		default: {
			const never: never = approval
			return never
		}
	}
}
function verdictWord(verdict: 'pass' | 'fail') {
	switch (verdict) {
		case 'pass':
			return 'Pass'
		case 'fail':
			return 'Blocked'
		default: {
			const never: never = verdict
			return never
		}
	}
}
export function SecretsAccessScene(props: {
	approval: SecretApproval
	shot: number
}) {
	const { approval, shot } = props
	const request = accessRequest(approval)
	const mid = accessHeight / 2
	return (
		<PrimitiveWidgetFrame
			id="secrets"
			size="full"
			height={accessHeight}
			className="pw-scene-sec-access"
			stack
		>
			<div
				className="pw-run"
				key={`${approval}-${shot}`}
				data-approval={approval}
			>
				{wires(
					wire({ key: 'check', d: `M137 ${mid} L166 ${mid}`, on: true }),
					accessHeight,
				)}
				<div className="pw-node pw-sec-card pw-sec-request" style={at(0, 50)}>
					<span className="pw-kicker">Incoming request</span>
					<strong>{request.title}</strong>
					<span>{request.detail}</span>
					<code>{secretRef}</code>
					<small className="pw-sec-note">{request.note}</small>
				</div>
				<div className="pw-node pw-sec-card pw-sec-sheet" style={at(46, 50)}>
					<div className="pw-sec-head">
						<span className="pw-lock" aria-hidden="true"></span>
						<strong>Credential access</strong>
						<span className="pw-sec-pill">Example</span>
					</div>
					{(Object.keys(accessRows) as Array<SecretApproval>).map((id) => {
						const row = accessRows[id]
						const on = id === approval
						return (
							<div
								key={id}
								className="pw-sec-row"
								data-on={on ? '' : undefined}
								data-verdict={row.verdict}
							>
								<span>{row.label}</span>
								<b>{on ? verdictWord(row.verdict) : 'Not checked'}</b>
								<code>{row.value}</code>
							</div>
						)
					})}
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
export type SecretSource = 'saved' | 'vault'
const vaultHeight = 226
function sourceLabel(source: SecretSource) {
	switch (source) {
		case 'saved':
			return 'Saved in Kody'
		case 'vault':
			return 'Configured vault provider'
		default: {
			const never: never = source
			return never
		}
	}
}
export function SecretsVaultScene(props: {
	source: SecretSource
	shot: number
}) {
	const { source, shot } = props
	const vault = source === 'vault'
	const y = (percent: number) => Math.round((percent / 100) * vaultHeight)
	return (
		<PrimitiveWidgetFrame
			id="secrets"
			size="full"
			height={vaultHeight}
			className="pw-scene-sec-vault"
			stack
		>
			<div className="pw-run" key={`${source}-${shot}`} data-source={source}>
				{wires(
					<>
						{wire({
							key: 'ref',
							d: `M151 ${y(23)} L202 ${y(23)}`,
							on: true,
						})}
						{wire({
							key: 'fetch',
							d: `M151 ${y(77)} C180 ${y(77)} 173 ${y(40)} 202 ${y(40)}`,
							on: true,
						})}
						{wire({
							key: 'key',
							d: `M281 ${y(50)} L281 ${y(62)}`,
							on: true,
						})}
					</>,
					vaultHeight,
				)}
				<div className="pw-node pw-sec-card pw-sec-model" style={at(0, 0)}>
					<div className="pw-sec-head">
						{icon('claude')}
						<strong>Model</strong>
					</div>
					<p>Charge invoice 2041.</p>
					<span className="pw-sec-k">Sees the reference</span>
					<code className="pw-sec-ref">{secretRef}</code>
					<span className="pw-sec-mask">
						<code>sk_••••••••</code>
						<small>not visible</small>
					</span>
				</div>
				<div
					className="pw-node pw-sec-card pw-sec-source"
					id="ms-source-drawer"
					style={at(0, 54)}
				>
					{vault ? (
						<div className="pw-sec-op">
							<span className="pw-sec-op-mark" aria-hidden="true"></span>
							<strong>1Password</strong>
						</div>
					) : (
						<div className="pw-sec-head">
							<span className="pw-lock" aria-hidden="true"></span>
							<strong>Your account</strong>
						</div>
					)}
					<span className="pw-sec-k">
						{vault ? 'Private vault' : 'Saved secret'}
					</span>
					<span className="pw-sec-item">Stripe · live key</span>
					<code className="pw-sec-mask-code">sk_••••••••</code>
					<small id="ms-source-label">{sourceLabel(source)}</small>
				</div>
				<span
					className="pw-sec-chip pw-sec-chip-ref"
					style={at(49, 23)}
					aria-hidden="true"
				>
					ref
				</span>
				<span
					className="pw-sec-chip pw-sec-chip-fetch"
					style={at(49, 58.5)}
					aria-hidden="true"
				>
					{vault ? 'fetch' : 'saved'}
				</span>
				<span className="pw-sec-flow" aria-hidden="true">
					{vault ? 'reference + vault item' : 'reference + saved key'}
				</span>
				<div className="pw-node pw-sec-card pw-sec-boundary" style={at(56, 0)}>
					<span className="pw-sec-glass" aria-hidden="true"></span>
					<strong>Request boundary</strong>
					<span className="pw-sec-k">
						{vault ? 'Fetches the vault item' : 'Attaches the saved key'}
					</span>
					<span className="pw-sec-hop">
						<span>in · reference</span>
						<span>out · key</span>
					</span>
				</div>
				<span
					className="pw-sec-chip pw-sec-chip-key"
					style={at(78, 56)}
					aria-hidden="true"
				>
					sk_••••
				</span>
				<div className="pw-node pw-sec-card pw-sec-api" style={at(56, 62)}>
					<div className="pw-sec-head">
						{icon('stripe')}
						<strong>Approved API</strong>
					</div>
					<span className="pw-sec-host-name">api.stripe.com</span>
					<span className="pw-sec-k">receives key</span>
					<code className="pw-sec-bearer">{attachedKey}</code>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
const draftHeight = 216
export function SecretsDraftScene() {
	const mid = draftHeight / 2
	return (
		<PrimitiveWidgetFrame
			id="secrets"
			size="full"
			height={draftHeight}
			className="pw-scene-sec-draft"
			stack
		>
			<div className="pw-run">
				{wires(
					wire({ key: 'draft', d: `M115 ${mid} L166 ${mid}`, on: true }),
					draftHeight,
				)}
				<div className="pw-node pw-sec-card pw-sec-composer" style={at(0, 50)}>
					<div className="pw-sec-head">
						{icon('claude')}
						<strong>Agent</strong>
					</div>
					<p>Draft a reply to Morgan about invoice 2041. Do not send it.</p>
					<span className="pw-sec-k">drafts-only package</span>
				</div>
				<span
					className="pw-sec-chip pw-sec-chip-draft"
					style={at(39, 50)}
					aria-hidden="true"
				>
					draft
				</span>
				<div className="pw-node pw-sec-card pw-sec-gmail" style={at(46, 50)}>
					<div className="pw-sec-head">
						<span className="pw-sec-gmail-mark" aria-hidden="true">
							M
						</span>
						<strong>Gmail</strong>
						<span className="pw-sec-pill">Drafts</span>
					</div>
					<div className="pw-sec-mail pw-sec-mail-new">
						<span className="pw-sec-who">Morgan Chen</span>
						<span className="pw-sec-pill">Draft</span>
						<strong>Re: March invoice</strong>
						<p>Thanks — attaching the receipt for 2041. I'll wait for you.</p>
					</div>
					<div className="pw-sec-mail">
						<span className="pw-sec-who">Northwind</span>
						<span className="pw-sec-pill">Draft</span>
						<strong>Weekly brief</strong>
						<p>Orchard update ships Thursday.</p>
					</div>
					<div className="pw-sec-sendbar">
						<div className="pw-sec-locked">
							<span className="pw-lock" aria-hidden="true"></span>
							<span>Send</span>
							<small>Locked</small>
						</div>
						<div className="pw-sec-you">
							<strong>You send</strong>
							<small>in Gmail</small>
						</div>
					</div>
					<small className="pw-sec-ready">Draft ready for your review</small>
				</div>
			</div>
		</PrimitiveWidgetFrame>
	)
}
