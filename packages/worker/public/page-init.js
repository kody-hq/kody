/* oxlint-disable no-undef -- classic browser script served from public/;
   the lint config's browser env does not apply here. */
// Runs as a blocking classic script in <head> so enhance-only motion can
// gate on `html.js` before first paint. Inline scripts are blocked by CSP
// (`script-src 'self'`), hence this file. Color scheme is CSS-only
// (`prefers-color-scheme`); this script does not set a theme.
;(function () {
	document.documentElement.classList.add('js')

	// `<form data-save-on-change>` (the device sign-in code screen's "Keep
	// this browser signed in"): post the form in the background whenever a
	// field changes, so the visible Save button is only needed without
	// JavaScript. Plain ES5 for e-reader browsers that never hydrate.
	document.addEventListener('change', function (event) {
		var field = event.target
		var form = field && field.form
		if (!form || !form.hasAttribute('data-save-on-change')) return
		var parts = []
		for (var index = 0; index < form.elements.length; index += 1) {
			var element = form.elements[index]
			if (!element.name || element.disabled) continue
			if (
				(element.type === 'checkbox' || element.type === 'radio') &&
				!element.checked
			) {
				continue
			}
			if (element.type === 'submit' || element.type === 'button') continue
			parts.push(
				encodeURIComponent(element.name) +
					'=' +
					encodeURIComponent(element.value),
			)
		}
		if (typeof fetch !== 'function') {
			form.submit()
			return
		}
		fetch(form.action, {
			method: 'POST',
			credentials: 'same-origin',
			redirect: 'manual',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: parts.join('&'),
		}).catch(function () {
			form.submit()
		})
	})

	// Smooth scrolling is for anchors clicked while you're already on the page.
	// Arriving at a #hash must land instantly, so opt in only after the
	// browser's initial jump has settled.
	addEventListener('load', function () {
		requestAnimationFrame(function () {
			document.documentElement.classList.add('is-settled')
		})
	})
})()
