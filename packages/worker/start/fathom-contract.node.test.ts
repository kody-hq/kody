import { expect, test } from 'vitest'
import { firstPartySecurityHeaders } from '../src/app/security-headers.ts'

test('CSP permits the analytics script without unsafe script execution', () => {
	const csp = firstPartySecurityHeaders['Content-Security-Policy']
	if (!csp) throw new Error('Missing first-party CSP')
	const scriptSrc = csp
		.split(';')
		.map((directive) => directive.trim().split(/\s+/))
		.find(([name]) => name === 'script-src')
		?.slice(1)
	if (!scriptSrc) throw new Error('Missing script-src directive')

	expect(scriptSrc).toContain('https://cdn.usefathom.com')
	expect(scriptSrc).not.toContain("'unsafe-inline'")
	expect(scriptSrc).not.toContain("'unsafe-eval'")
})
