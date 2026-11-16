# UI components

Shared UI primitives live in `packages/worker/start/components`. Render these
instead of raw elements or copied style objects.
`kody-custom/no-raw-button-style`, `kody-custom/no-raw-form-control`, and
`kody-custom/no-raw-dialog` reject the raw forms in `packages/worker/start` and
`packages/worker/client`.

Every component passes native attributes through. Refs are ordinary props (React
19), so `ref` reaches the underlying element. Pass `css` to adjust layout
(width, margin, grid placement), not the look.

## Button

`start/components/button.tsx`

```tsx
<Button variant="primary" size="md" onClick={save}>Save</Button>
<Button variant="secondary" href="/docs">Docs</Button>
<Button variant="ghost" size="sm" iconOnly aria-label="Close"><CloseIcon /></Button>
```

- `variant`: `primary` (default) | `secondary` | `ghost` | `danger`
- `size`: `xs` | `sm` | `md` (default) | `lg`
- `iconOnly`: square button; needs `aria-label`
- `href`: renders a `SiteLink` with the same look
- `mobileFullWidth`: stretches to the row on narrow screens
- Pending work: set `disabled` and change the label ("Saving..."). There is no
  `loading` prop.

## Field

`start/components/field.tsx`

```tsx
<Field label="Email" description="We never share it." error={errors.email}>
	<Input type="email" name="email" required />
</Field>
```

The label wraps the control, so it is labelled without ids. The description and
error get ids only when present and reach the control through
`aria-describedby`; `aria-invalid` is set while `error` is set. Props you pass
to the control win.

- `label` (required), `description`, `error`
- Custom controls join a field with `useFieldControl(props)` and spread the
  result onto the focusable element.

## Input, Textarea, Select

`start/components/input.tsx`

```tsx
<Input type="search" aria-label="Search packages" />
<Textarea name="notes" />
<Select name="plan" size="sm">
	<option value="free">Free</option>
</Select>
```

- `size`: `md` (default, forms) | `sm` (dense toolbars, tables)
- `background`: `surface` (default) | `canvas` (inside a surface card)
- `Input` accepts text-like `type`s only. Use `Checkbox`, `Radio`, or `Button`
  for the others. Native `hidden`, `file`, `range`, and `color` inputs stay raw.
- Never render an unstyled `<select>`. For a searchable list use `Combobox`.

## Checkbox, Radio, Switch

`start/components/choice-controls.tsx`

```tsx
<label css={rowCss}>
	<Checkbox name="all" checked={allState} onChange={toggleAll} /> Select all
</label>
<Switch aria-label="Enabled" checked={on} onCheckedChange={setOn} />
```

- `Checkbox`: native checkbox. `checked` also takes `'mixed'` for a partly
  selected group (sets `indeterminate`).
- `Radio`: native radio; group them with the same `name` in a `fieldset`.
- `Switch`: `role="switch"` button for settings that apply immediately.
  `checked` and `onCheckedChange` are required. Space and Enter toggle it. Name
  it with `aria-label`, `aria-labelledby`, or a `Field`. Use `Checkbox` for
  values submitted with a form.

## Dialog

`start/components/dialog.tsx`

```tsx
<Dialog
	open={open}
	onClose={() => setOpen(false)}
	title="Rename file"
	description="Names must be unique."
>
	<Field label="Name">
		<Input name="name" />
	</Field>
	<DialogActions>
		<Button variant="secondary" onClick={() => setOpen(false)}>
			Cancel
		</Button>
		<Button onClick={save}>Save</Button>
	</DialogActions>
</Dialog>
```

Built on Base UI. Focus moves to the first focusable element on open, Tab stays
inside, Escape closes, and focus returns to the opener on close. The page behind
is inert and does not scroll.

- Name it with `title` (rendered as the heading, plus optional `description`) or
  with `aria-label` when the content draws its own heading. Not both.
- `role="alertdialog"` for destructive or irreversible confirmations: an outside
  click never closes it. Otherwise outside clicks are ignored unless
  `dismissOnOutsideClick` is set.
- `open` is controlled. `onClose` runs on Escape or an outside click; the dialog
  closes when you set `open` to `false`, so a pending action can keep it open.
- `size`: `sm` (default, 448px) | `md` (512px) | `lg` (640px)
- `placement`: `center` (default) | `side` (full-height panel from the inline
  end)
- `flush`: drop the padding when the content draws its own sections.
- `DialogActions`: right-aligned, wrapping row for the buttons.

## When a raw control is right

Some surfaces are editors rather than form fields (a borderless code editor, a
textarea layered over highlighted text, an inline rename sized to a tree row).
Keep those raw with a reason:

```tsx
{
	/* oxlint-disable-next-line kody-custom/no-raw-form-control -- borderless source editor surface */
}
;<textarea css={sourceCss} aria-label="Document text" />
```

Full-screen viewers (image, video), the command palette, and the avatar crop
editor keep a native `<dialog>` with a `kody-custom/no-raw-dialog` exemption:
they draw their own chrome and capture keys that a standard dialog would not.
