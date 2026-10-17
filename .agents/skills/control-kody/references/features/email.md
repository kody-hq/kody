# Email inbox

Per-user stored mail (notify-self, reply) and email destinations.

## How to get there

`/@<slug>/-/email` → `/@<slug>/-/email/:messageId`. Destinations sit on the
inbox list at `/@<slug>/-/email#email-destinations`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/email
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

Classify and delete messages and manage destinations through the UI. Delete
requires a second click. Additional destinations still confirm through
`/verify-email-destination`.

## Gotchas

- Preview seed starts empty. Inbound mail is not something a Cloud Agent can
  mint without the email store APIs.
- The account email is always listable and cannot be removed here; extras must
  verify before `emailSend` can use them. Cap is 5 extras. Mail comes from
  `{username}@platform`.
