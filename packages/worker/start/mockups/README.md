# Mockups

Proposed UI built from real components, rendered by the local dev server at
`/dev/mockups`. Use a mockup to show a design before building the feature.

## Write one

Add `<name>.mockup.tsx` anywhere in this folder. Default-export a `Mockup`:

```tsx
/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import type { Mockup } from './mockup.ts'

export default {
	title: 'Run as you confirmation',
	shell: 'bare', // or 'marketing', 'focused', 'workspace'
	states: {
		default: () => <Button variant="primary">Allow</Button>,
		declined: () => <p>The app was not allowed to run.</p>,
	},
} satisfies Mockup
```

Compose shared components from `../components` and page pieces from `../pages`,
and style new elements with the tokens in `#universal/styles/tokens.ts` so both
color schemes follow. Pass fixture data as props.

## View it

With `npm run dev` running, open `/dev/mockups` for the list, then
`/dev/mockups/<name>?state=<key>`. Workspace mockups render at
`/@<org>/-/dev-mockups/<name>` and need a signed-in session
(`npm run control-kody -- login`). The color scheme follows your system.

Workspace mockups pick the highlighted rail item with `rail` (for example
`rail: 'apps'`). It defaults to `overview`.

## Screenshot it

```sh
npm run mockup -- examples/delete-file-dialog
```

This starts the dev server when needed and writes
`<state>-<light|dark>-<desktop|mobile>.png` for every state plus a labeled
`contact-sheet.png` to `.tmp/mockups/<name>/`. Desktop is 1440 wide; mobile is
390 wide at 2x with touch.

- `--states a,b`: only these states.
- `--only light-desktop,dark-mobile`: only these variants.
- `--signed-in`: use the local session for any shell (workspace always does).
- `--keep-focus`: keep the initial focus ring, which is cleared by default.

The target may also be a path. A `.mockup.tsx` outside this folder is copied
into `local/` first.

## Folders

- `examples/`: committed references for each shell.
- `local/`: your one-off mockups. Git ignores it.

Mockups load only on the dev server (`npm run dev`). Production builds drop
them, and the routes return 404 in production.
