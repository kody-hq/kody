# Request handlers

How to write a Worker request handler, such as the Open API routes in
`packages/worker/src/open-api/` and the publish build upload routes in
`packages/worker/src/publish-offload/`. Lint enforces the same rules for those
directories (see [Oxlint JS plugins](./oxlint-js-plugins.md)).

## Decode untrusted input with zod at the edge

- Read a JSON body with `decodeJsonRequestBody(request, { schema, maxBytes })`
  from `#worker/decode-request-body.ts`. It reads at most `maxBytes`, parses the
  JSON, and decodes it with the zod schema.
- Decode stored or forwarded JSON (a sealed document, a header value) with
  `decodeUntrusted(schema, value)` from the same module.
- Map the typed result once: `body_too_large`, `invalid_json`, and
  `invalid_shape` become a 400. Past the edge, code works with the decoded type.
- Put every shape rule in the schema, including cross-field rules such as "the
  main module is one of the uploaded modules" (use `Object.hasOwn` for key
  membership).
- Read raw bodies (chunks, files) with `readRequestBodyUpTo` from
  `#worker/read-request-body-up-to.ts` so the size cap applies while streaming.

## Give every outbound call a deadline

- Wrap D1, KV, R2, `fetch`, RPC, and Durable Object calls in
  `withDeadline({ label, timeoutMs }, (signal) => call(signal))` from
  `#worker/outbound/with-deadline.ts`. Pass `signal` to calls that accept one.
- Choose `timeoutMs` at the call site; `outboundTimeoutMs` has the shared values
  per binding.
- Map a `DeadlineExceededError` to a typed failure with `deadlineFailure` or
  `catchDeadline` from `#worker/outbound/typed-failure.ts`, and answer 503 with
  `Retry-After`.

## Return typed failures and map them at the edge

- Model each way a handler refuses a request as a `{ kind: ... }` union and map
  it to a response in one exhaustive `switch` ending in `assertNever`.
- Make a catch rethrow, return a typed failure, hand the error to an
  `...ErrorResponse` edge mapper, or report it with `reportHandledError` when
  the request goes ahead on purpose.
- Await or return every promise, or hand it to `waitUntil` for work after the
  response.
- Enforce per-resource limits with one atomic statement (a conditional D1
  `UPDATE`) so concurrent requests count against the same total.

## Queue consumers, Durable Object alarms, and crons

The same rules apply off the request path, with three additions. The webhook
dispatch consumer and the jobs schedule watchdog follow them, and the
request-path safety override in `tools/oxlint/oxlint-rules.json` lists the files
lint enforces them on.

- Settle queue messages with `settleQueueBatch` from
  `@kody-internal/shared/queue-settlement.ts`. Return a `QueueDisposition`
  (`ack` or `retry` with a delay) from `decide`; it settles each message exactly
  once, turns a thrown decision into `onDecideFailure`'s disposition, and keeps
  one bad message from failing the batch.
  `kody-custom/no-direct-queue-settlement` rejects direct `ack()` and `retry()`
  calls.
- Put cleanup that must only follow an ack (a spilled payload delete) in
  `afterAck`. Put backpressure in `concurrency` and in explicit caps (users per
  tick, rows per scan), and count what a cap skipped.
- When a loop keeps going after one item fails (fan-out to many Durable Objects,
  best-effort repair), give each call its own `withDeadline`, count the failure,
  and report it with `reportConsumerError` or `reportConsumerWarning` from
  `@kody-internal/shared/consumer-errors.ts`. A state read that only gates an
  alert fails open.
- When a lookup that decides between ack and a terminal record fails, retry.
  Never treat an unknown answer as "not found".
