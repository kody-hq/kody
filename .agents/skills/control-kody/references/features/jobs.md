# Jobs

Package-owned schedules and their run history.

## How to get there

`/@<slug>/-/jobs` and `/@<slug>/-/jobs/:jobId`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /@<slug>/-/jobs
```

Preview seed has no jobs until a package with `kody.jobs` exists.

## Transport

The browser uses native Start server functions for job reads and mutations.

## Gotchas

- Republishing `"enabled": false` does not disable a running job. Use
  `jobUpdate` or the package pause export.
