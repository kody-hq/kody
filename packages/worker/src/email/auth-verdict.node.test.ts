import { expect, test } from 'vitest'
import {
	extractAuthservId,
	failedSenderAuthenticationReason,
	isCloudflareEmailAuthservId,
	resolveInboundEmailAuthVerdict,
	selectTrustedCloudflareAuthResults,
} from './auth-verdict.ts'

test('isCloudflareEmailAuthservId accepts Cloudflare ids and rejects lookalikes', () => {
	expect(isCloudflareEmailAuthservId('mx.cloudflare.net')).toBe(true)
	expect(isCloudflareEmailAuthservId('email.cloudflare.net')).toBe(true)
	expect(isCloudflareEmailAuthservId('cloudflare.net')).toBe(true)
	expect(isCloudflareEmailAuthservId('mx.example.com')).toBe(false)
	expect(isCloudflareEmailAuthservId('notcloudflare.net')).toBe(false)
	expect(isCloudflareEmailAuthservId('mx.cloudflare.net.evil.example')).toBe(
		false,
	)
	expect(isCloudflareEmailAuthservId('cloudflare.net.evil.example')).toBe(false)
})

test('extractAuthservId reads AR and ARC authserv-ids', () => {
	expect(
		extractAuthservId('mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass'),
	).toBe('mx.cloudflare.net')
	expect(
		extractAuthservId(
			'i=1; mx.cloudflare.net; spf=pass (sender); dkim=pass; dmarc=pass',
		),
	).toBe('mx.cloudflare.net')
	expect(extractAuthservId('i=1; mx.google.com; arc=none')).toBe(
		'mx.google.com',
	)
})

test('selectTrustedCloudflareAuthResults ignores forged and third-party stamps', () => {
	const forgedOnly = new Headers()
	forgedOnly.append(
		'Authentication-Results',
		'evil.example; spf=pass; dkim=pass; dmarc=pass',
	)
	expect(selectTrustedCloudflareAuthResults(forgedOnly)).toBeNull()

	const gmailArcOnly = new Headers()
	gmailArcOnly.append(
		'ARC-Authentication-Results',
		'i=1; mx.google.com; arc=none',
	)
	expect(selectTrustedCloudflareAuthResults(gmailArcOnly)).toBeNull()

	// Later comma-joined stamps are attacker-controlled; only the leftmost
	// Cloudflare stamp counts (CF prepends at the edge).
	const forgedThenCloudflare = new Headers()
	forgedThenCloudflare.append(
		'Authentication-Results',
		'evil.example; dmarc=pass',
	)
	forgedThenCloudflare.append(
		'Authentication-Results',
		'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail',
	)
	expect(selectTrustedCloudflareAuthResults(forgedThenCloudflare)).toBeNull()

	const cloudflareThenForged = new Headers()
	cloudflareThenForged.append(
		'Authentication-Results',
		'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail',
	)
	cloudflareThenForged.append(
		'Authentication-Results',
		'evil.example; spf=pass; dkim=pass; dmarc=pass',
	)
	expect(selectTrustedCloudflareAuthResults(cloudflareThenForged)).toBe(
		'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail',
	)

	const cloudflareArc = new Headers()
	cloudflareArc.append(
		'ARC-Authentication-Results',
		'i=1; mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass',
	)
	expect(selectTrustedCloudflareAuthResults(cloudflareArc)).toBe(
		'i=1; mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass',
	)

	const joinedArc = new Headers()
	joinedArc.append('ARC-Authentication-Results', 'i=1; mx.google.com; arc=none')
	joinedArc.append(
		'ARC-Authentication-Results',
		'i=2; mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail',
	)
	expect(selectTrustedCloudflareAuthResults(joinedArc)).toBeNull()

	const forgedPassAfterCfFail = new Headers()
	forgedPassAfterCfFail.append(
		'Authentication-Results',
		'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail, mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass',
	)
	expect(selectTrustedCloudflareAuthResults(forgedPassAfterCfFail)).toBe(
		'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail',
	)
	expect(
		resolveInboundEmailAuthVerdict(
			selectTrustedCloudflareAuthResults(forgedPassAfterCfFail),
		),
	).toMatchObject({
		suspect: true,
		reason: failedSenderAuthenticationReason,
	})
})

test('resolveInboundEmailAuthVerdict parses Authentication-Results into auth/suspect verdicts', () => {
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com',
		),
	).toEqual({
		spf: 'pass',
		dkim: 'pass',
		dmarc: 'pass',
		dmarcHeaderFrom: 'example.com',
		authenticated: true,
		suspect: false,
		reason: null,
	})

	// ARC i= clauses and parenthetical comments are ignored; case is normalized.
	expect(
		resolveInboundEmailAuthVerdict(
			'MX.CLOUDFLARE.NET; i=1; SPF=PASS (sender ip is 203.0.113.1); DKIM=PASS (good signature); DMARC=PASS (p=none)',
		),
	).toMatchObject({
		spf: 'pass',
		dkim: 'pass',
		dmarc: 'pass',
		authenticated: true,
		suspect: false,
	})

	// Multiple DKIM results prefer pass over earlier non-pass results.
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; dkim=fail header.d=bad.example; dkim=pass header.d=example.com; spf=none; dmarc=none',
		),
	).toMatchObject({
		dkim: 'pass',
		authenticated: true,
		suspect: false,
	})

	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=fail header.from=example.com',
		),
	).toMatchObject({
		dmarc: 'fail',
		authenticated: false,
		suspect: true,
		reason: failedSenderAuthenticationReason,
	})

	// Both SPF and DKIM failed with no DMARC policy → suspect.
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dkim=fail header.d=example.com; dmarc=none header.from=example.com',
		),
	).toMatchObject({
		authenticated: false,
		suspect: true,
		reason: failedSenderAuthenticationReason,
	})
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=softfail smtp.mailfrom=example.com; dkim=fail; dmarc=none',
		),
	).toMatchObject({
		suspect: true,
		reason: failedSenderAuthenticationReason,
	})

	// SPF fail alone (DKIM none/unknown) with no DMARC policy is not suspect.
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dkim=none header.d=example.com; dmarc=none header.from=example.com',
		),
	).toMatchObject({
		authenticated: false,
		suspect: false,
		reason: null,
	})
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=softfail smtp.mailfrom=example.com; dmarc=none header.from=example.com',
		),
	).toMatchObject({
		spf: 'softfail',
		dkim: 'unknown',
		suspect: false,
	})

	// SPF fail with DKIM pass stays authenticated when DMARC is not fail.
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; spf=fail smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=none header.from=example.com',
		),
	).toMatchObject({
		spf: 'fail',
		dkim: 'pass',
		authenticated: true,
		suspect: false,
	})

	// Missing / unparseable headers fail open (not authenticated, not suspect).
	for (const input of [null, '', 'not-an-auth-results-header'] as const) {
		expect(resolveInboundEmailAuthVerdict(input)).toEqual({
			spf: 'unknown',
			dkim: 'unknown',
			dmarc: 'unknown',
			dmarcHeaderFrom: null,
			authenticated: false,
			suspect: false,
			reason: null,
		})
	}
})

test('resolveInboundEmailAuthVerdict keeps the header.from domain of the passing DMARC clause', () => {
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; dkim=pass header.d=evil.example; dmarc=pass (p=reject) header.from=Evil.Example policy.dmarc=reject; spf=pass smtp.mailfrom=evil.example',
		).dmarcHeaderFrom,
	).toBe('evil.example')
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; dmarc=pass header.from="example.com"',
		).dmarcHeaderFrom,
	).toBe('example.com')
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; dmarc=fail header.from=other.example; dmarc=pass header.from=example.com',
		).dmarcHeaderFrom,
	).toBeNull()
	expect(
		resolveInboundEmailAuthVerdict('mx.cloudflare.net; dmarc=pass')
			.dmarcHeaderFrom,
	).toBeNull()
	expect(
		resolveInboundEmailAuthVerdict(
			'mx.cloudflare.net; dmarc=fail header.from=example.com',
		).dmarcHeaderFrom,
	).toBeNull()
})

test('uses only the first header stamp', () => {
	const stamp = 'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail'
	for (const name of ['Authentication-Results', 'ARC-Authentication-Results']) {
		const first = name.startsWith('ARC-') ? `i=1; ${stamp}` : stamp
		for (const later of [
			'dmarc=pass header.from=acme.com',
			'dkim=none; dmarc=pass header.from=acme.com',
			'x=y; dmarc=pass header.from=acme.com; spf=pass',
		]) {
			const headers = new Headers()
			headers.append(name, first)
			headers.append(name, later)
			expect(selectTrustedCloudflareAuthResults(headers)).toBe(first)
			for (const input of [
				selectTrustedCloudflareAuthResults(headers),
				headers.get(name),
			]) {
				expect(resolveInboundEmailAuthVerdict(input)).toMatchObject({
					spf: 'fail',
					dkim: 'fail',
					dmarc: 'fail',
					dmarcHeaderFrom: null,
					authenticated: false,
					suspect: true,
				})
			}
			const reversed = new Headers()
			reversed.append(name, later)
			reversed.append(name, first)
			expect(selectTrustedCloudflareAuthResults(reversed)).toBeNull()
		}
	}
})

test('stops at the first raw comma', () => {
	for (const [detail, closing] of [
		['a"b', 'x"'],
		['a(b', 'x)'],
	]) {
		const stamp = `mx.cloudflare.net; dkim=fail header.d=${detail}; dmarc=fail header.from=acme.com`
		const headers = new Headers()
		headers.append('Authentication-Results', stamp)
		headers.append(
			'Authentication-Results',
			`${closing}; dmarc=pass header.from=acme.com`,
		)
		expect(selectTrustedCloudflareAuthResults(headers)).toBe(stamp)
		for (const input of [
			selectTrustedCloudflareAuthResults(headers),
			headers.get('Authentication-Results'),
		]) {
			expect(resolveInboundEmailAuthVerdict(input)).toMatchObject({
				dkim: 'fail',
				dmarc: 'fail',
				dmarcHeaderFrom: null,
				authenticated: false,
				suspect: true,
			})
		}
	}
})

test('uses first SPF and DMARC clauses', () => {
	for (const first of ['fail', 'pass', 'unrecognized']) {
		const expected = first === 'unrecognized' ? 'unknown' : first
		expect(
			resolveInboundEmailAuthVerdict(
				`mx.cloudflare.net; spf=${first}; spf=pass; dmarc=${first} header.from=first.example; dmarc=pass header.from=later.example`,
			),
		).toMatchObject({
			spf: expected,
			dmarc: expected,
			dmarcHeaderFrom: first === 'pass' ? 'first.example' : null,
			authenticated: first === 'pass',
		})
	}
})

test('uses any DKIM pass or the first result', () => {
	for (const [clauses, expected] of [
		['dkim=fail; dkim=pass; dkim=fail', 'pass'],
		['dkim=unrecognized; dkim=fail', 'unknown'],
		['dkim=fail; dkim=none', 'fail'],
	]) {
		expect(
			resolveInboundEmailAuthVerdict(`mx.cloudflare.net; ${clauses}`).dkim,
		).toBe(expected)
	}
})
