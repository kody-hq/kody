/* oxlint-disable no-undef -- classic browser script served from public/;
   the lint config's browser env does not apply here. */
// Low-JavaScript fallback for Kody's sign-in forms (ADR 0094). Older browsers
// (for example e-readers on Chromium 80) may not run the page's app
// JavaScript, which is what normally draws the Turnstile human check. When
// the page has not hydrated a few seconds after load, this plain ES5 script
// draws the check itself so the server-rendered form can still be posted.
;(function () {
	var hydratedAttribute = 'data-hydrated'
	function renderFallbackChecks() {
		if (document.documentElement.getAttribute(hydratedAttribute) === 'true') {
			return
		}
		var boxes = document.querySelectorAll('.kody-turnstile[data-sitekey]')
		if (!boxes.length) return
		window.__kodyTurnstileFallback = function () {
			if (!window.turnstile) return
			for (var index = 0; index < boxes.length; index += 1) {
				var box = boxes[index]
				if (box.getAttribute('data-turnstile-rendered') === 'true') continue
				box.setAttribute('data-turnstile-rendered', 'true')
				box.setAttribute('data-turnstile-fallback', 'true')
				window.turnstile.render(box, {
					sitekey: box.getAttribute('data-sitekey'),
					'response-field-name': 'turnstileToken',
				})
			}
		}
		var script = document.createElement('script')
		script.src =
			'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__kodyTurnstileFallback'
		script.async = true
		document.head.appendChild(script)
	}
	function start() {
		setTimeout(renderFallbackChecks, 2500)
	}
	if (document.readyState === 'complete') start()
	else window.addEventListener('load', start)
})()
