#!/usr/bin/env bash
# $1 is browser.enabled. Later words: team (team approvals), mention (the admin's Discord mention), chrome (chrome: true).
set -e
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/seed.sh" "$1"
config=.hermit/config.json
bun -e '
const [file, enabled, ...flags] = process.argv.slice(1);
const config = await Bun.file(file).json();
if (enabled === "true") {
  const mentions = flags.includes("mention") ? { discord: "<@100000000000000001>" } : {};
  Object.assign(config.browser, {
    admins: [{ login: "admin@example.test", mentions }],
    port: 8443,
    host: "agent.example.test",
  });
}
if (flags.includes("team")) config.approvals = "team";
if (flags.includes("chrome")) config.chrome = true;
await Bun.write(file, JSON.stringify(config) + "\n");
' "$config" "$@"
