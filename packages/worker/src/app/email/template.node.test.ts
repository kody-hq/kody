import { expect, test } from 'vitest'
import {
	buildAdvocateReferralEmail,
	buildBillingSuccessEmail,
	buildPastDueEmail,
	buildPaymentFailedEmail,
	buildConnectAgentEmail,
	buildCoolingHomeEmail,
	buildKeepPackageEmail,
	buildPlatformFeedbackAcknowledgementEmail,
	buildPlatformFeedbackOutcomeEmail,
	buildSecondAgentEmail,
	buildUserEntitlementWarningEmail,
	buildUserErrorRateEmail,
	buildVerificationEmail,
	buildEmailDestinationVerificationEmail,
} from './messages.ts'
import { renderTransactionalEmail } from './template.ts'

test('transactional emails escape untrusted content and put action URLs in both parts', () => {
	const email = renderTransactionalEmail({
		appBaseUrl: 'https://kody.codes',
		subject: 'Subject <script>',
		preheader: 'Preheader "quoted"',
		heading: 'Heading & more',
		body: ['Body <b>text</b>'],
		action: {
			label: 'Do the thing',
			url: 'https://kody.codes/verify-email?token=a&redirectTo=/x',
		},
		afterAction: ['Expires soon.'],
		footnote: 'Ignore if unexpected.',
		unsubscribe: {
			label: 'Unsubscribe from tips',
			url: 'https://kody.codes/unsubscribe/tips?token=abc',
		},
	})

	expect(email.html).not.toContain('<script>')
	expect(email.html).toContain('Heading &amp; more')
	expect(email.html).toContain('Body &lt;b&gt;text&lt;/b&gt;')
	expect(email.html).toContain(
		'https://kody.codes/verify-email?token=a&amp;redirectTo=/x',
	)
	expect(email.text).toContain(
		'Do the thing: https://kody.codes/verify-email?token=a&redirectTo=/x',
	)
	expect(email.html).toContain('Unsubscribe from tips')
	expect(email.html).toContain('https://kody.codes/unsubscribe/tips?token=abc')
	expect(email.text).toContain(
		'Unsubscribe from tips: https://kody.codes/unsubscribe/tips?token=abc',
	)

	const verificationUrl = 'https://kody.codes/verify-email?token=abc123'
	const verification = buildVerificationEmail({
		appBaseUrl: 'https://kody.codes',
		verificationUrl,
	})
	expect(verification.html).toContain(verificationUrl)
	expect(verification.text).toContain(verificationUrl)

	const destinationUrl =
		'https://kody.codes/verify-email-destination?token=abc123'
	const destination = buildEmailDestinationVerificationEmail({
		appBaseUrl: 'https://kody.codes',
		destinationEmail: 'phone@example.com',
		verificationUrl: destinationUrl,
	})
	expect(destination.html).toContain(destinationUrl)
	expect(destination.text).toContain(destinationUrl)
	expect(destination.html).toContain('phone@example.com')

	const warning = buildUserEntitlementWarningEmail({
		appBaseUrl: 'https://kody.codes',
		creditsUrl: 'https://kody.codes/account/usage#credits',
		usageUrl: 'https://kody.codes/account/usage',
		kind: 'approaching',
		warnings: [
			{
				label: 'unique execute workers per day',
				resource: 'execute_unique_workers_per_day',
				current: 200,
				limit: 250,
				percentOfLimit: 0.8,
			},
		],
	})
	expect(warning.subject).toContain('approaching')
	expect(warning.html).toContain('https://kody.codes/account/usage#credits')
	expect(warning.text).toContain('https://kody.codes/account/usage')
	expect(warning.html).toContain('200 of 250 (80%)')
	expect(warning.html).toContain('https://kody.codes/docs/local-execute')
	expect(warning.text).toContain('https://kody.codes/docs/local-execute')

	const reached = buildUserEntitlementWarningEmail({
		appBaseUrl: 'https://kody.codes',
		creditsUrl: 'https://kody.codes/account/usage#credits',
		usageUrl: 'https://kody.codes/account/usage',
		kind: 'reached',
		warnings: [
			{
				label: 'unique execute workers per day',
				resource: 'execute_unique_workers_per_day',
				current: 250,
				limit: 250,
				percentOfLimit: 1,
			},
		],
	})
	expect(reached.subject).toContain('reached')
	expect(reached.html).toContain('250 of 250 (100%)')
	expect(reached.text).toContain('https://kody.codes/docs/local-execute')

	const storageOnly = buildUserEntitlementWarningEmail({
		appBaseUrl: 'https://kody.codes',
		creditsUrl: 'https://kody.codes/account/usage#credits',
		usageUrl: 'https://kody.codes/account/usage',
		kind: 'reached',
		warnings: [
			{
				label: 'storage bytes',
				resource: 'storage_bytes',
				current: 1_000_000,
				limit: 1_000_000,
				percentOfLimit: 1,
			},
		],
	})
	expect(storageOnly.text).not.toContain('/docs/local-execute')

	const connect = buildConnectAgentEmail({
		appBaseUrl: 'https://kody.codes',
		onboardingUrl: 'https://kody.codes/onboarding',
	})
	expect(connect.subject).toBe('Connect the agent you already use')
	expect(connect.html).toContain('https://kody.codes/onboarding')
	expect(connect.text).toContain('https://kody.codes/onboarding')

	const keep = buildKeepPackageEmail({
		appBaseUrl: 'https://kody.codes',
		onboardingUrl: 'https://kody.codes/onboarding',
		clientLabel: 'Cursor',
	})
	expect(keep.subject).toBe('Keep what Cursor just figured out')
	expect(keep.html).toContain('https://kody.codes/onboarding')
	const keepFallback = buildKeepPackageEmail({
		appBaseUrl: 'https://kody.codes',
		onboardingUrl: 'https://kody.codes/onboarding',
		clientLabel: 'your agent',
	})
	expect(keepFallback.text).toContain(
		'You got Your agent to use Kody to do something',
	)
	expect(keepFallback.text).toContain("Let's talk about how we can use Kody")
	expect(keep.html).toContain('<blockquote')
	expect(keep.html).toContain('Let&#39;s talk about how we can use Kody')

	const second = buildSecondAgentEmail({
		appBaseUrl: 'https://kody.codes',
		portabilityUrl: 'https://kody.codes/guides/portability',
	})
	expect(second.html).toContain('https://kody.codes/guides/portability')
	expect(second.text).not.toContain('/account/billing')

	const secondWithTrial = buildSecondAgentEmail({
		appBaseUrl: 'https://kody.codes',
		portabilityUrl: 'https://kody.codes/guides/portability',
		trialUrl: 'https://kody.codes/account/billing',
	})
	expect(secondWithTrial.text).toContain('https://kody.codes/account/billing')

	const cooling = buildCoolingHomeEmail({
		appBaseUrl: 'https://kody.codes',
		onboardingUrl: 'https://kody.codes/onboarding',
	})
	expect(cooling.subject).toBe('Your home is still here')
	expect(cooling.html).toContain('https://kody.codes/onboarding')

	const advocate = buildAdvocateReferralEmail({
		appBaseUrl: 'https://kody.codes',
		shareUrl: 'https://kody.codes/signup?ref=kentcdodds',
	})
	expect(advocate.subject).toBe('Share Kody (and get a month free)')
	expect(advocate.html).toContain('https://kody.codes/signup?ref=kentcdodds')
	expect(advocate.text).toContain(
		'Email a short testimonial: mailto:me@kentcdodds.com?subject=Kody%20testimonial',
	)

	const paymentFailed = buildPaymentFailedEmail({
		appBaseUrl: 'https://kody.codes',
		billingUrl: 'https://kody.codes/account/billing',
	})
	expect(paymentFailed.html).toContain('data-error-agent-prompt')
	expect(paymentFailed.html).toContain('Paste this prompt')
	expect(paymentFailed.text).toContain('billing_payment_failed')
	expect(paymentFailed.text).toContain('/account/billing')

	const pastDue = buildPastDueEmail({
		appBaseUrl: 'https://kody.codes',
		billingUrl: 'https://kody.codes/account/billing',
	})
	expect(pastDue.html).toContain('data-error-agent-prompt')
	expect(pastDue.text).toContain('billing_past_due')

	const billing = buildBillingSuccessEmail({
		appBaseUrl: 'https://kody.codes',
		billingUrl: 'https://kody.codes/account/billing',
		discordUrl: 'https://kcd.im/kody-discord',
		planLabel: 'Pro',
	})
	expect(billing.subject).toContain('Pro')
	expect(billing.html).toContain('https://kcd.im/kody-discord')
	expect(billing.text).toContain('https://kody.codes/account/billing')

	const errorRate = buildUserErrorRateEmail({
		appBaseUrl: 'https://kody.codes',
		activityUrl: 'https://kody.codes/account/activity',
		supportUrl: 'https://kody.codes/support',
		errorCount: 10,
		eventCount: 40,
	})
	expect(errorRate.html).toContain('https://kody.codes/account/activity')
	expect(errorRate.text).toContain('/support')
	expect(errorRate.html).toContain('25%')
	expect(errorRate.text).not.toContain('most recent open failure')

	const namedErrorRate = buildUserErrorRateEmail({
		appBaseUrl: 'https://kody.codes',
		activityUrl: 'https://kody.codes/account/activity',
		supportUrl: 'https://kody.codes/support',
		errorCount: 10,
		eventCount: 40,
		failingRuns: [
			{
				label: 'Package <b>review-ticket</b>',
				error: 'Request refused (credential_placement_refused, slot "token")',
				runUrl: 'https://kody.codes/account/activity/run-1',
			},
		],
	})
	expect(namedErrorRate.text).toContain(
		'Package <b>review-ticket</b> failed: Request refused (credential_placement_refused, slot "token") Open the run: https://kody.codes/account/activity/run-1',
	)
	expect(namedErrorRate.html).toContain('Package &lt;b&gt;review-ticket')
	expect(namedErrorRate.html).not.toContain('<b>review-ticket</b>')
	expect(namedErrorRate.html).toMatch(
		/<a href="https:\/\/kody\.codes\/account\/activity\/run-1"[^>]*>Open the run<\/a>/,
	)
	expect(namedErrorRate.text).toContain('most recent open failure')

	const acknowledgement = buildPlatformFeedbackAcknowledgementEmail({
		appBaseUrl: 'https://kody.codes',
		feedbackId: 'feedback-<script>1</script>',
	})
	expect(acknowledgement.subject).toContain('got your')
	expect(acknowledgement.html).toContain('metaPlatformFeedbackGet')
	expect(acknowledgement.html).toContain(
		'feedback-&lt;script&gt;1&lt;/script&gt;',
	)
	expect(acknowledgement.html).not.toContain('<script>1</script>')
	expect(acknowledgement.text).toContain('metaPlatformFeedbackGet')

	const hostileSummary = '</p><script>alert(1)</script>Setup is confusing'
	const genericResolved = buildPlatformFeedbackOutcomeEmail({
		appBaseUrl: 'https://kody.codes',
		status: 'resolved',
		summary: hostileSummary,
	})
	expect(genericResolved.subject).toContain('resolved')
	expect(genericResolved.html).not.toContain('<script>')
	expect(genericResolved.html).toContain(
		'&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;Setup is confusing',
	)
	expect(genericResolved.text).toContain(`"${hostileSummary}"`)
	expect(genericResolved.text).toContain(
		'tell your agent you want to send more Kody feedback',
	)

	const dismissedWithNote = buildPlatformFeedbackOutcomeEmail({
		appBaseUrl: 'https://kody.codes',
		status: 'dismissed',
		summary: hostileSummary,
		userMessage: 'We shipped a clearer setup path. <em>Thanks</em>.',
		prUrls: ['https://github.com/example/repo/pull/42'],
	})
	expect(dismissedWithNote.subject).toContain('update')
	expect(dismissedWithNote.html).toContain(
		'closed it without a product change this time',
	)
	expect(dismissedWithNote.html).toContain(
		'We shipped a clearer setup path. &lt;em&gt;Thanks&lt;/em&gt;.',
	)
	expect(dismissedWithNote.html).not.toContain('<em>Thanks</em>')
	expect(dismissedWithNote.html).toContain(
		'href="https://github.com/example/repo/pull/42"',
	)
	expect(dismissedWithNote.text).toContain(
		'https://github.com/example/repo/pull/42',
	)
})
