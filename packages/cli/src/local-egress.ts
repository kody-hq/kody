/**
 * Outbound network policy for local workerd runs. When set, every outbound
 * fetch goes through a small gate worker (`globalOutbound`) that refuses what
 * the policy does not allow with a plain explanation instead of workerd's
 * opaque `internal error; reference = …`.
 */
type LocalEgressMode = 'public' | 'public-and-lan' | 'allowlist' | 'none'

/** A local network destination the machine defines by name: IP literals or CIDR ranges, plus ports. */
export type LocalLanRule = {
	name: string
	hosts: Array<string>
	ports: Array<number>
}

export type LocalEgressPolicy = {
	mode: LocalEgressMode
	hosts?: Array<string>
	ports?: Array<number>
	/**
	 * Named destinations a request the mode refuses may still reach, once Kody
	 * authorizes the run for that name. Matched by address, never by host name,
	 * so a public name that resolves to a local address is still refused.
	 */
	lan?: Array<LocalLanRule>
	/**
	 * In `public-and-lan` mode, ask Kody before the run's first request to each
	 * local address or local name (`localhost`, `.local`) and port. Set for
	 * execution context runs, whose machine wide switch is a Kody entry;
	 * `kody execute --local` leaves it off.
	 */
	askWholeLan?: boolean
	/** Whose setting refused it, e.g. "this execution context's network setting". */
	setting: string
	/** How to change it; `{host}` is replaced with the blocked host. */
	hint: string
}

/** Response header the gate sets; the entry turns such responses into thrown errors. */
export const egressBlockedHeader = 'x-kody-egress-blocked'

export const egressGateModuleName = '__kody_egress_gate.js'

/** Bridge route the egress gate asks why an HTTPS fetch failed. */
export const localBridgeTlsCheckPath = '/tls-check'

/** The name Kody gives the machine wide local network switch's entry. */
export const wholeLanCapabilityName = '*'

/** Bridge route the egress gate asks Kody through before using a named local network destination. */
export const localBridgeLanAuthorizePath = '/lan-authorize'

/** workerd network service that reaches local addresses; only the egress gate is bound to it. */
export const lanNetworkServiceName = 'lan'

export function egressPolicyFromGrant(
	egress: {
		mode: string
		hosts?: Array<string>
		ports?: Array<number>
	},
	lan: ReadonlyArray<LocalLanRule> = [],
): LocalEgressPolicy {
	const mode: LocalEgressMode =
		egress.mode === 'public-and-lan' ||
		egress.mode === 'allowlist' ||
		egress.mode === 'none'
			? egress.mode
			: 'public'
	return {
		mode,
		...(egress.hosts?.length ? { hosts: egress.hosts } : {}),
		...(egress.ports?.length ? { ports: egress.ports } : {}),
		...(lan.length
			? {
					lan: lan.map(({ name, hosts, ports }) => ({ name, hosts, ports })),
				}
			: {}),
		...(mode === 'public-and-lan' ? { askWholeLan: true } : {}),
		setting: "this execution context's network setting",
		hint: 'This is the server grant, not local policy. Anyone with Contribute or Manage on the context can turn the local network on with `kody context grant lan on --context <name>`, or set executionContextUpdate grant.egress to an allowlist that includes {host}.',
	}
}

export function localExecuteEgressPolicy(
	allowPrivateNetwork: boolean | undefined,
): LocalEgressPolicy {
	return {
		mode: allowPrivateNetwork ? 'public-and-lan' : 'public',
		setting: "kody execute --local's network setting",
		hint: 'Re-run with --allow-private-network to allow private and local network addresses.',
	}
}

/** workerd network classes the `internet` service may reach under this policy. */
export function egressNeedsPrivateNetwork(policy: LocalEgressPolicy) {
	return policy.mode === 'public-and-lan' || policy.mode === 'allowlist'
}

export function createEgressGateSource(): string {
	return `
const blockedHeader = ${JSON.stringify(egressBlockedHeader)};

function isPrivateHost(host) {
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
	const v4 = host.match(/^(\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)$/);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127);
	}
	if (host.includes(':')) {
		const mapped = host.match(/^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/);
		if (mapped) return isPrivateHost(mapped[1]);
		return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
	}
	return false;
}

function hostAllowed(hosts, host) {
	return hosts.some((entry) => {
		const rule = String(entry).toLowerCase();
		return rule === host || (rule.startsWith('*.') && host.endsWith(rule.slice(1)));
	});
}

function v4Bytes(text) {
	const match = text.match(/^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$/);
	if (!match) return null;
	const bytes = match.slice(1).map(Number);
	return bytes.every((byte) => byte <= 255) ? bytes : null;
}

function v6Bytes(text) {
	if (!text.includes(':')) return null;
	const lastColon = text.lastIndexOf(':');
	const v4 = v4Bytes(text.slice(lastColon + 1));
	const halves = (v4 ? text.slice(0, lastColon + 1) + '0:0' : text).split('::');
	if (halves.length > 2) return null;
	const groupsOf = (part) => (part === '' ? [] : part.split(':'));
	const head = groupsOf(halves[0]);
	const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const bytes = [];
	for (const group of [...head, ...Array(missing).fill('0'), ...rest]) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
		const value = parseInt(group, 16);
		bytes.push(value >> 8, value & 255);
	}
	if (v4) bytes.splice(12, 4, ...v4);
	return bytes;
}

// An address as 4 or 16 bytes plus how many leading bits count. IPv4-mapped IPv6 is IPv4.
function addressBits(text, prefixText) {
	const v4 = v4Bytes(text);
	const bytes = v4 ?? v6Bytes(text);
	if (!bytes) return null;
	const prefix = prefixText === undefined ? bytes.length * 8 : Number(prefixText);
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > bytes.length * 8) return null;
	const mapped = !v4 && bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255;
	if (mapped && prefix >= 96) return { bytes: bytes.slice(12), prefix: prefix - 96 };
	return { bytes, prefix };
}

function addressInRule(rule, address) {
	const [base, prefixText, ...extra] = String(rule).split('/');
	const range = extra.length === 0 ? addressBits(base, prefixText) : null;
	if (!range || range.bytes.length !== address.bytes.length) return false;
	for (let bit = 0; bit < range.prefix; bit += 8) {
		const mask = (0xff << (8 - Math.min(8, range.prefix - bit))) & 0xff;
		if ((range.bytes[bit >> 3] & mask) !== (address.bytes[bit >> 3] & mask)) return false;
	}
	return true;
}

// The named destinations that cover this address and port, or one that covers only the address.
function lanMatch(rules, host, port) {
	const address = addressBits(host);
	if (!address) return null;
	const covering = rules.filter((rule) => rule.hosts.some((entry) => addressInRule(entry, address)));
	const matching = covering.filter((entry) => entry.ports.includes(port));
	return matching.length ? { rules: matching } : covering[0] ? { portMiss: covering[0] } : null;
}

function modeText(policy) {
	switch (policy.mode) {
		case 'none': return 'this context allows no network access (egress mode "none")';
		case 'allowlist': return 'this context only allows ' + ((policy.hosts ?? []).join(', ') || 'no hosts') + ' (egress mode "allowlist")';
		case 'public-and-lan': return 'this context allows public internet and local network (egress mode "public-and-lan")';
		default: return 'this context allows public internet only (egress mode "public")';
	}
}

// Addresses Kody already allowed this run under the machine wide switch.
const wholeLanAllowed = new Set();
// Questions still on their way to Kody, so parallel first requests to one address ask once.
const wholeLanAsking = new Map();

export default {
	async fetch(request, env) {
		const policy = env.KODY_EGRESS_POLICY;
		const url = new URL(request.url);
		const host = url.hostname.replace(/^\\[|\\]$/g, '').toLowerCase();
		const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
		const block = (why) => new Response(
			'Blocked by ' + policy.setting + ': the request to ' + host + (url.port ? ':' + url.port : '') +
				' was refused because ' + modeText(policy) + (why ? ', and ' + why : '') + '. ' +
				policy.hint.replaceAll('{host}', host),
			{ status: 403, headers: { [blockedHeader]: '1', 'content-type': 'text/plain; charset=utf-8' } },
		);
		if (policy.mode === 'none') return block('');
		// IPv4-mapped IPv6 (::ffff:7f00:1) is the IPv4 address it carries.
		const literal = addressBits(host);
		const refusal =
			policy.mode === 'allowlist' && !hostAllowed(policy.hosts ?? [], host)
				? host + ' is not on the list'
				: policy.ports?.length && !policy.ports.includes(port)
					? 'port ' + port + ' is not one of the allowed ports (' + policy.ports.join(', ') + ')'
					: policy.mode === 'public' && isPrivateHost(literal?.bytes.length === 4 ? literal.bytes.join('.') : host)
						? host + ' is a private or local network address'
						: null;
		if (refusal !== null) {
			const lan = policy.lan?.length ? lanMatch(policy.lan, host, port) : null;
			if (!lan?.rules) {
				return block(refusal + (lan?.portMiss
					? ' (this machine\\'s local network destination "' + lan.portMiss.name + '" covers that address on ' +
						(lan.portMiss.ports.length === 1 ? 'port ' : 'ports ') + lan.portMiss.ports.join(', ') + ' only)'
					: ''));
			}
			// Destinations can overlap, and a run may be granted only one of them: the first Kody allows wins.
			let refused = null;
			for (const rule of lan.rules) {
				let message;
				try {
					const reply = await env.KODY_BRIDGE.fetch('http://kody-bridge${localBridgeLanAuthorizePath}', {
						method: 'POST',
						headers: { [env.KODY_BRIDGE_SECRET_HEADER]: env.KODY_RUN_SECRET, 'content-type': 'application/json' },
						body: JSON.stringify({ capability: rule.name, host, port }),
					});
					const verdict = await reply.json();
					if (verdict?.ok === true) {
						refused = null;
						break;
					}
					message = typeof verdict?.message === 'string' ? verdict.message : 'No reason was given.';
				} catch (error) {
					message = 'Kody could not be asked: ' + (error instanceof Error ? error.message : String(error));
				}
				refused ??= { rule, message };
			}
			if (refused) {
				return new Response(
					'Blocked: the request to ' + host + ':' + port + ' needs this machine\\'s local network destination "' +
						refused.rule.name + '", and Kody refused it. ' + refused.message,
					{ status: 403, headers: { [blockedHeader]: '1', 'content-type': 'text/plain; charset=utf-8' } },
				);
			}
		}
		const privateTarget = isPrivateHost(literal?.bytes.length === 4 ? literal.bytes.join('.') : host);
		if (refusal === null && policy.askWholeLan && policy.mode === 'public-and-lan' && privateTarget && !wholeLanAllowed.has(host + ' ' + port)) {
			// The machine wide switch is a Kody entry too: Kody records the use and may refuse the run's packages.
			const key = host + ' ' + port;
			let asking = wholeLanAsking.get(key);
			if (!asking) {
				asking = (async () => {
					try {
						const reply = await env.KODY_BRIDGE.fetch('http://kody-bridge${localBridgeLanAuthorizePath}', {
							method: 'POST',
							headers: { [env.KODY_BRIDGE_SECRET_HEADER]: env.KODY_RUN_SECRET, 'content-type': 'application/json' },
							body: JSON.stringify({ capability: ${JSON.stringify(wholeLanCapabilityName)}, host, port }),
						});
						const verdict = await reply.json();
						if (verdict?.ok === true) {
							wholeLanAllowed.add(key);
							return null;
						}
						return typeof verdict?.message === 'string' ? verdict.message : 'No reason was given.';
					} catch (error) {
						return 'Kody could not be asked: ' + (error instanceof Error ? error.message : String(error));
					} finally {
						wholeLanAsking.delete(key);
					}
				})();
				wholeLanAsking.set(key, asking);
			}
			const message = await asking;
			if (message !== null) {
				return new Response(
					'Blocked: the request to ' + host + ':' + port + ' uses this machine\\'s whole local network, and Kody refused it. ' + message,
					{ status: 403, headers: { [blockedHeader]: '1', 'content-type': 'text/plain; charset=utf-8' } },
				);
			}
		}
		try {
			// A named destination's redirects go back to the run, so each hop is checked here again.
			return refusal !== null
				? await env.KODY_LAN.fetch(new Request(request, { redirect: 'manual' }))
				: await fetch(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// workerd hides TLS failures behind "internal error"; ask Node which cert check failed.
			if (url.protocol === 'https:' && env.KODY_BRIDGE) {
				try {
					const check = await env.KODY_BRIDGE.fetch('http://kody-bridge${localBridgeTlsCheckPath}', {
						method: 'POST',
						headers: { [env.KODY_BRIDGE_SECRET_HEADER]: env.KODY_RUN_SECRET, 'content-type': 'application/json' },
						body: JSON.stringify({ host, port }),
					});
					const verdict = await check.json();
					if (verdict && typeof verdict.message === 'string') {
						return new Response(verdict.message, { status: 502, headers: { [blockedHeader]: '1', 'content-type': 'text/plain; charset=utf-8' } });
					}
				} catch {}
			}
			if (refusal === null && policy.mode === 'public' && /internal error/i.test(message)) {
				return block(host + ' resolves to a private or local network address (or could not be reached)');
			}
			throw error;
		}
	},
};
`.trimStart()
}
