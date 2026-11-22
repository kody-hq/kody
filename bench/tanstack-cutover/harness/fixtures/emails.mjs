// Identical inbound email fixtures (10: the local free-plan inbound quota) delivered through wrangler's local email handler.
// Usage: node emails.mjs http://127.0.0.1:PORT
const origin = process.argv[2]
const senders = ['alice@example.com', 'bob@example.org', 'billing@vendor.example', 'news@letters.example', 'carol@example.net']
const subjects = ['Invoice for November', 'Weekly team sync notes', 'Your package was starred', 'Re: workshop schedule', 'Build failed on main', 'Lunch on Thursday?', 'Quarterly report draft', 'Conference talk accepted', 'Password policy update', 'New comment on your post']
const results = []
for (let i = 1; i <= 10; i += 1) {
	const from = senders[i % senders.length]
	const subject = `${subjects[i % subjects.length]} #${i}`
	const day = String(1 + (i % 20)).padStart(2, '0')
	const body = Array.from({ length: 6 }, (_, p) => `Paragraph ${p + 1} of benchmark fixture message ${i}. This text gives the message detail page realistic content to render.`).join('\r\n\r\n')
	const raw = [`From: ${from}`, 'To: user-me@kody.local', `Subject: ${subject}`, `Message-ID: <bench-${i}@fixtures.example>`, `Date: Sun, ${day} Nov 2026 1${i % 10}:00:00 +0000`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n')
	const url = new URL('/cdn-cgi/handler/email', origin)
	url.searchParams.set('from', from)
	url.searchParams.set('to', 'user-me@kody.local')
	const response = await fetch(url, { method: 'POST', body: raw })
	results.push({ i, status: response.status, text: (await response.text()).slice(0, 120) })
}
console.log(JSON.stringify({ ok: results.every((r) => r.status < 300), results: results.filter((r) => r.status >= 300) }))
