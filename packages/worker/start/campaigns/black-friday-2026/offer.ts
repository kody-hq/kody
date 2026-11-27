/**
 * Black Friday 2026 offer: the one place for its dates, prices, and copy.
 * Safe to import from the browser. Promotion code names are server-only
 * (see `server.ts`). Removal steps are in the README next to this file.
 */

export const blackFridayCampaignId = 'blackfriday-2026'

/**
 * Must match `expires_at` (1796108399) on both Stripe promotion codes.
 * If they ever differ, checkout still asks Stripe, finds the code expired or
 * inactive, and continues at full price.
 */
export const blackFridayEndsAtMs = Date.parse('2026-11-30T23:59:59-07:00')

const endsLabel = 'Ends Nov 30, 11:59 PM MT.'

/** Pro list prices and the two coupon percents. Must match Stripe. */
const offer = {
	year: { listCents: 12_000, percentOff: 25 },
	month: { listCents: 1_200, percentOff: 50, months: 2 },
} as const

export const blackFridayDismissStorageKey = `kody.campaign.${blackFridayCampaignId}.dismissed`
export const blackFridayHiddenAttribute = 'data-bf2026-hidden'
export const blackFridayCountdownAttribute = 'data-bf2026-countdown'

export function isBlackFridayActive(nowMs: number) {
	return nowMs < blackFridayEndsAtMs
}

function dollars(cents: number) {
	return `$${Number.isInteger(cents / 100) ? cents / 100 : (cents / 100).toFixed(2)}`
}

function salePrice(input: { listCents: number; percentOff: number }) {
	return dollars(Math.round((input.listCents * (100 - input.percentOff)) / 100))
}

const monthCountWords = ['zero', 'one', 'two', 'three'] as const

const monthlyOffer = `Or start monthly at ${salePrice(offer.month)} for ${monthCountWords[offer.month.months]} months, then ${dollars(offer.month.listCents)}.`
const annualSale = salePrice(offer.year)
const annualList = dollars(offer.year.listCents)

export type BlackFridayAudience = 'signed-out' | 'free'

export const blackFridayCopy = {
	kicker: 'Black Friday',
	dismissLabel: 'Dismiss Black Friday offer',
	'signed-out': {
		body: `Annual Pro is ${annualSale} for the first year, normally ${annualList}. ${monthlyOffer}`,
		meta: endsLabel,
		cta: 'Create an account',
	},
	free: {
		body: `Upgrade to annual Pro for ${annualSale} the first year, normally ${annualList}. ${monthlyOffer}`,
		meta: `We'll apply the code at checkout. ${endsLabel}`,
		cta: 'Upgrade to Pro',
	},
} as const

/**
 * `4d 4h 37m`, `23h 5m`, `42m`, or `less than a minute`. Leading zero units
 * are dropped. Self-contained on purpose: the pre-paint script embeds this
 * function's source, so it must not use anything outside its own body.
 */
export function formatBlackFridayCountdown(remainingMs: number) {
	var minutes = Math.floor(remainingMs / 60000)
	if (minutes < 1) return 'less than a minute'
	var days = Math.floor(minutes / 1440)
	var hours = Math.floor((minutes % 1440) / 60)
	var parts = []
	if (days > 0) parts.push(days + 'd')
	if (days > 0 || hours > 0) parts.push(hours + 'h')
	parts.push((minutes % 60) + 'm')
	return parts.join(' ')
}

export function blackFridayCountdownText(remainingMs: number) {
	return `${formatBlackFridayCountdown(remainingMs)} left.`
}

/**
 * Runs right after the banner markup, before first paint. Server HTML has
 * no clock in it (signed-out pages are shared from the edge cache), so this
 * fills the countdown from the visitor's clock, and hides the banner for a
 * visitor who dismissed it or who got a cached page after the sale ended.
 */
export function blackFridayPrePaintScript() {
	return `(function(){var r=document.documentElement,n=Date.now(),d=false;try{d=localStorage.getItem(${JSON.stringify(blackFridayDismissStorageKey)})==='1'}catch(e){}if(d||n>=${blackFridayEndsAtMs}){r.setAttribute(${JSON.stringify(blackFridayHiddenAttribute)},'');return}var s=document.querySelectorAll('[${blackFridayCountdownAttribute}]');for(var i=0;i<s.length;i++)s[i].textContent=(${formatBlackFridayCountdown.toString()})(${blackFridayEndsAtMs}-n)+' left.'})()`
}
