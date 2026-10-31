# Recap block

One block. Copy this shape. Put the rollup in the summary (`composes` and low,
`extends` and medium, or `adds` and high). Label every message with what this PR
does. Leave a blank line after `<summary>` and around every fence, or GitHub
will not render the diagram. Participants are primitive `id`s from
`primitives.yaml`. Prefer a sequence diagram. Add a second diagram only when it
shows something the first cannot. Omit optional sections rather than leaving
them empty.

Link a touched primitive's `adrs` (from the classifier) in the table or below it
when the change bears on that decision.

Optional sections (add only when they have real content): **Before / after**
(schema, API shape, or route changes as compact before/after fenced blocks or
tables); **Invariants** (only when the change touches an invariant from
`primitives.yaml`); **Plan vs actual** (recap mode only, when a plan-mode block
existed — what shipped as planned and what drifted).

<!-- system-recap:start -->

<details>
<summary>System recap: <b>composes existing primitives</b> (low risk)</summary>

**Mode:** recap · **Base:** `main` @ `abc1234` · **Head:** `def5678`

**Classification:** composes. No primitives added or changed.

### Primitives touched

| Primitive             | Group     | Impact   |
| --------------------- | --------- | -------- |
| `mcp-server`          | surfaces  | composes |
| `capability-registry` | assistant | composes |

### Change flow

MCP search and execute read the capability registry.

```mermaid
sequenceDiagram
	participant mcpServer as mcp-server
	participant registry as capability-registry
	mcpServer->>registry: search and execute read the registry
```

</details>

<!-- system-recap:end -->
