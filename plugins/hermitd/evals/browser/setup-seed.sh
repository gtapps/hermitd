#!/usr/bin/env bash
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/seed.sh" "$1"
config=.hermit/config.json
bun -e '
const [file, enabled, approvals] = process.argv.slice(1);
const config = await Bun.file(file).json();
if (enabled === "true") {
  Object.assign(config.browser, {
    admins: [{ login: "admin@example.test", mentions: {} }],
    port: 8443,
    host: "agent.example.test",
  });
}
if (approvals === "team") config.approvals = "team";
await Bun.write(file, JSON.stringify(config) + "\n");
' "$config" "$1" "${2:-}"
