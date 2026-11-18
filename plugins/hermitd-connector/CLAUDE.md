# hermitd-connector

The in-agent channel of the hermitd connector: one stdio MCP server, `server.ts`, declared inline in `.claude-plugin/plugin.json` and bound by its `channels` entry. No skills, hooks or agents.

The contract with core is core's own: the socket path in `HERMIT_CONNECTOR_SOCKET`, the routes `GET /events?after=<id>&instance=<id>` and `POST /replies`, and the envelope keys. Core's trusted server (`plugins/hermitd/scripts/connector-gateway.ts`) owns sign-in, pairing and the message record; keep this side stateless.

Bun built-ins only. Tests: `bun test` from this directory.
