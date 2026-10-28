import { escapeHtml } from '@kody-internal/shared/escape-html.ts'
import {
	emailFooterMark,
	emailHeaderLogo,
	type EmailBrandImage,
} from './brand-images.ts'

/**
 * Shared layout for every transactional email Kody sends. Table-based with
 * inline styles because email clients strip most modern CSS; the
 * `prefers-color-scheme` block below is a progressive enhancement for the
 * clients that do honor a `<style>` element.
 */

type EmailAction = {
	label: string
	url: string
}

export type EmailAfterActionBlock = string | { kind: 'quote'; text: string }

/** A body paragraph, or one that ends in a link (rendered as an anchor in HTML). */
export type EmailBodyBlock = string | { text: string; link: EmailAction }

export type TransactionalEmailContent = {
	/** Absolute origin used to load the Kody logo and mark; keeps the images reachable from mail clients. */
	appBaseUrl: string
	/** Subject line, also used as the document title. */
	subject: string
	/** Short line clients show next to the subject in the inbox list. */
	preheader: string
	/** Large headline at the top of the card. */
	heading: string
	/** Body paragraphs shown above the action button. */
	body: Array<EmailBodyBlock>
	/** Primary call to action. */
	action?: EmailAction
	/** Quieter second action under the primary button. */
	secondaryAction?: EmailAction
	/** Paragraphs or quoted prompts shown below the action button, above the footer. */
	afterAction?: Array<EmailAfterActionBlock>
	/** Small muted line at the very bottom of the card. */
	footnote?: string
	/** Trusted HTML comment stamped into the card (inventory markers). */
	htmlComment?: string
	/** Optional one-click opt-out for Kody tips campaign mail only. */
	unsubscribe?: EmailAction
}

export type RenderedEmail = {
	subject: string
	html: string
	text: string
}

const colors = {
	canvas: '#eef1f0',
	card: '#ffffff',
	border: '#dfe4e2',
	text: '#22262b',
	muted: '#5c6570',
	accent: '#12813f',
	accentText: '#ffffff',
}

const fontStack =
	"'Wix Madefor Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const displayFontStack =
	"'Bricolage Grotesque', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

function paragraphs(
	values: Array<EmailBodyBlock>,
	className: string,
	style: string,
) {
	return values
		.map((value) => {
			if (typeof value === 'string') {
				return `<p class="${className}" style="${style}">${escapeHtml(value)}</p>`
			}
			return `<p class="${className}" style="${style}">${escapeHtml(value.text)} <a href="${escapeHtml(value.link.url)}" class="kody-link" style="color: ${colors.accent};">${escapeHtml(value.link.label)}</a></p>`
		})
		.join('\n                ')
}

function bodyText(values: Array<EmailBodyBlock>) {
	return values.map((value) =>
		typeof value === 'string'
			? value
			: `${value.text} ${value.link.label}: ${value.link.url}`,
	)
}

function afterActionBlocks(
	values: Array<EmailAfterActionBlock>,
	mutedStyle: string,
	quoteStyle: string,
) {
	return values
		.map((value) => {
			if (typeof value === 'string') {
				return `<p class="kody-muted" style="${mutedStyle}">${escapeHtml(value)}</p>`
			}
			return `<blockquote class="kody-text" style="${quoteStyle}">${escapeHtml(value.text)}</blockquote>`
		})
		.join('\n                ')
}

/**
 * Hosted PNG on its own white plate (baked into the image), so the black
 * light-mode artwork stays readable when a client darkens the email.
 */
function brandImage(
	image: EmailBrandImage,
	appBaseUrl: string,
	centered = false,
) {
	const src = new URL(image.src, appBaseUrl).toString()
	return `<img src="${escapeHtml(src)}" alt="Kody" width="${image.width}" height="${image.height}" style="display: block;${centered ? ' margin: 0 auto;' : ''} width: ${image.width}px; height: ${image.height}px; border: 0; outline: none; text-decoration: none;" />`
}

function afterActionText(values: Array<EmailAfterActionBlock>) {
	return values.map((value) =>
		typeof value === 'string' ? value : `"${value.text}"`,
	)
}

export function renderTransactionalEmail(
	content: TransactionalEmailContent,
): RenderedEmail {
	const bodyStyle = `margin: 0 0 16px; font-family: ${fontStack}; font-size: 16px; line-height: 1.6; color: ${colors.text};`
	const mutedStyle = `margin: 0 0 16px; font-family: ${fontStack}; font-size: 14px; line-height: 1.6; color: ${colors.muted};`
	const quoteStyle = `margin: 0 0 16px; padding: 12px 16px; border-left: 3px solid ${colors.accent}; font-family: ${fontStack}; font-size: 16px; line-height: 1.6; color: ${colors.text};`
	const action = content.action
	const secondaryAction = content.secondaryAction
	const actionBlock = action
		? `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
              <tr>
                <td align="center" bgcolor="${colors.accent}" style="border-radius: 999px;">
                  <a href="${escapeHtml(action.url)}" class="kody-button" style="display: inline-block; padding: 14px 28px; font-family: ${fontStack}; font-size: 16px; font-weight: 600; line-height: 1; color: ${colors.accentText}; text-decoration: none; border-radius: 999px;">${escapeHtml(action.label)}</a>
                </td>
              </tr>
            </table>
            <p class="kody-muted" style="${mutedStyle}">Button not working? Paste this link into your browser:<br /><a href="${escapeHtml(action.url)}" class="kody-link" style="color: ${colors.accent}; word-break: break-all;">${escapeHtml(action.url)}</a></p>${
							secondaryAction
								? `
            <p class="kody-muted" style="${mutedStyle}"><a href="${escapeHtml(secondaryAction.url)}" class="kody-link" style="color: ${colors.accent};">${escapeHtml(secondaryAction.label)}</a></p>`
								: ''
						}`
		: ''
	const footerMarkBlock = `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 16px 0 0;">
              <tr>
                <td align="center">
                  ${brandImage(emailFooterMark, content.appBaseUrl, true)}
                </td>
              </tr>
            </table>`

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(content.subject)}</title>
    <style>
      @media (prefers-color-scheme: dark) {
        .kody-canvas { background-color: #16191c !important; }
        .kody-card { background-color: #23272b !important; border-color: #34393e !important; }
        .kody-text { color: #f0f2f3 !important; }
        .kody-muted { color: #b3bac1 !important; }
        .kody-link { color: #6fd08c !important; }
      }
    </style>
  </head>
  <body class="kody-canvas" style="margin: 0; padding: 0; background-color: ${colors.canvas};">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${escapeHtml(content.preheader)}</div>
    <table role="presentation" class="kody-canvas" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${colors.canvas}; padding: 32px 16px;">
      <tr>
        <td align="center">
          <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px;">
            <tr>
              <td style="padding-bottom: 20px;">
                ${brandImage(emailHeaderLogo, content.appBaseUrl)}
              </td>
            </tr>
            <tr>
              <td class="kody-card" style="background-color: ${colors.card}; border: 1px solid ${colors.border}; border-radius: 14px; padding: 32px;">
                <h1 class="kody-text" style="margin: 0 0 16px; font-family: ${displayFontStack}; font-size: 24px; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; color: ${colors.text};">${escapeHtml(content.heading)}</h1>
                ${paragraphs(content.body, 'kody-text', bodyStyle)}${actionBlock}
                ${content.afterAction?.length ? afterActionBlocks(content.afterAction, mutedStyle, quoteStyle) : ''}${footerMarkBlock}${
									content.htmlComment
										? `<!-- ${escapeHtml(content.htmlComment)} -->`
										: ''
								}
              </td>
            </tr>
            ${
							content.footnote
								? `<tr>
              <td class="kody-muted" style="padding: 20px 8px 0; font-family: ${fontStack}; font-size: 13px; line-height: 1.6; color: ${colors.muted};">${escapeHtml(content.footnote)}</td>
            </tr>`
								: ''
						}
            ${
							content.unsubscribe
								? `<tr>
              <td class="kody-muted" style="padding: ${content.footnote ? '8px' : '20px'} 8px 0; font-family: ${fontStack}; font-size: 13px; line-height: 1.6; color: ${colors.muted};"><a href="${escapeHtml(content.unsubscribe.url)}" class="kody-link" style="color: ${colors.muted}; text-decoration: underline;">${escapeHtml(content.unsubscribe.label)}</a></td>
            </tr>`
								: ''
						}
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`

	const text = [
		content.heading,
		...bodyText(content.body),
		...(action ? [`${action.label}: ${action.url}`] : []),
		...(secondaryAction
			? [`${secondaryAction.label}: ${secondaryAction.url}`]
			: []),
		...(content.afterAction ? afterActionText(content.afterAction) : []),
		...(content.footnote ? [content.footnote] : []),
		...(content.unsubscribe
			? [`${content.unsubscribe.label}: ${content.unsubscribe.url}`]
			: []),
	].join('\n\n')

	return { subject: content.subject, html, text }
}
