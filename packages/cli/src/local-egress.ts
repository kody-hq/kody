/**
 * Outbound network policy for local workerd runs. When set, every outbound
 * fetch goes through a small gate worker (`globalOutbound`) that refuses what
 * the policy does not allow with a plain explanation instead of workerd's
 * opaque `internal error; reference = …`.
 */
type LocalEgressMode = 'public' | 'public-and-lan' | 'allowlist' | 'none'

export type LocalEgressPolicy = {
	mode: LocalEgressMode
	hosts?: Array<string>
	ports?: Array<number>
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

export function egressPolicyFromGrant(egress: {
	mode: string
	hosts?: Array<string>
	ports?: Array<number>
}): LocalEgressPolicy {
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

function modeText(policy) {
	switch (policy.mode) {
		case 'none': return 'this context allows no network access (egress mode "none")';
		case 'allowlist': return 'this context only allows ' + ((policy.hosts ?? []).join(', ') || 'no hosts') + ' (egress mode "allowlist")';
		case 'public-and-lan': return 'this context allows public internet and local network (egress mode "public-and-lan")';
		default: return 'this context allows public internet only (egress mode "public")';
	}
}

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
		if (policy.mode === 'allowlist' && !hostAllowed(policy.hosts ?? [], host)) {
			return block(host + ' is not on the list');
		}
		if (policy.ports?.length && !policy.ports.includes(port)) {
			return block('port ' + port + ' is not one of the allowed ports (' + policy.ports.join(', ') + ')');
		}
		if (policy.mode === 'public' && isPrivateHost(host)) {
			return block(host + ' is a private or local network address');
		}
		try {
			return await fetch(request);
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
			if (policy.mode === 'public' && /internal error/i.test(message)) {
				return block(host + ' resolves to a private or local network address (or could not be reached)');
			}
			throw error;
		}
	},
};
`.trimStart()
}
