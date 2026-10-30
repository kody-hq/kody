# MCP Events

Let webhook-capable MCP clients (such as ChatGPT) subscribe to topics your
packages emit. Usage lives in the [MCP Events guide](../guides/mcp-events.md)
(`search({ entity: "guide:mcp_events" })`).

MCP Events are an experiment (flag `mcp-events-extension`). Turn them on at
[`/account/experiments`](https://kody.codes/account/experiments) or with
`experimentSet({ experiment: "mcp-events", enabled: true })`.
