<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.0.19-green.svg" alt="Version 0.0.19" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# hermitd-laravel-forge

Turn Claude Code into a 24/7 assistant for your [Laravel Forge](https://forge.laravel.com) estate. **Forge-aware**, **Surface-then-approve**, **Official PHP SDK**, **Built on `hermitd`**.

<p align="center">
  <img src="../hermitd/assets/cover.png" alt="Always-on Claude Code Laravel Forge Agent" width="720" />
</p>

Deploys, manages servers and sites, reads logs, and runs a daily estate health scan; never firing a write without showing you the canonical target first. Wires the official `laravel/forge-sdk` PHP v4 into the [`hermitd`](https://github.com/gtapps/hermitd) loop, with project permission rules for native approval before deploy and reboot.

```
# Install
claude plugin install hermitd-laravel-forge --marketplace gtapps/hermitd --scope local

# Setup wizard
/hermitd-laravel-forge:hatch

# Go always-on
/hermitd:docker-setup
```

---

## What you get

| Skill | Purpose |
|---|---|
| `/hermitd-laravel-forge:forge-servers` | List servers, show detail, reboot (with preview → approve flow) |
| `/hermitd-laravel-forge:forge-sites` | List and inspect sites |
| `/hermitd-laravel-forge:forge-deploy` | Preview → approve → deploy; a hermit `/watch` monitors to completion; failure writes a scrubbed `deploy-incident` |
| `/hermitd-laravel-forge:forge-logs` | Latest deployment log, specific deployment log, server log, triage mode |
| `/hermitd-laravel-forge:forge-failed-deploys` | Daily estate scan — surfaces sites with failed latest deployments as `[reliability]` proposals |

Every write operation goes through **surface-then-approve**: the canonical target (server name, IP, site name, IDs) is shown before Claude Code requests native approval. A wrong reboot is an outage.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.292+, a paid Claude plan (Pro, Max, Teams, or Enterprise), PHP 8.5+ with `ext-json` and `ext-curl`, Composer (for the SDK install at hatch time), and a [Laravel Forge API token](https://forge.laravel.com/profile/api).

### 1. Install

```bash
cd /path/to/your/project   # any folder — empty is fine
claude plugin install hermitd-laravel-forge --marketplace gtapps/hermitd --scope local
```

### 2. Initialize

```
/hermitd-laravel-forge:hatch
```

The wizard triggers `hermitd:hatch` if the core hermit isn't ready, prompts for your `FORGE_API_TOKEN`, installs `laravel/forge-sdk` into an isolated runtime tree (`.hermit/forge-runtime/`), injects the Forge Workflow block into your `CLAUDE.md`, and registers the daily estate scan.

> **Just trying it?** After `hatch`, run `hermitd start --no-tmux` for sessions, routines, heartbeat, and the learning loop without 24/7 autonomy. Run `/hermitd:channel-setup` first if you want Discord or Telegram.

### 3. Go Always-On

```
/hermitd:docker-setup
```

Generates the Docker scaffolding, builds the image, starts the container, and walks through auth and channel pairing. The container ships with the hardening baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit`); see [DOCKER.md](DOCKER.md) for the Forge-specific apt deps and DNS allowlist. For LAN containment + resource bounds, follow up with [`/hermitd:docker-security`](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/docker-security.md).

See [Always-On Setup](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/always-on.md) for the full guide. Want always-on without Docker? See [Always-On Operations](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/always-on-ops.md) for bare tmux.

### Upgrading

```
claude plugin update hermitd@hermitd --scope local
claude plugin update hermitd-laravel-forge@hermitd --scope local
/hermitd:hermit-evolve
```

---

## Safety

Writes use native approval; generic writes also enforce request integrity:

- **Native approval**: project permission rules ask before deploy, reboot, and plan execution. Direct CLI execution outside Claude Code has no confirmation-only checkpoint; validation and policy denials still apply.
- **Hash-checked plans**: generic writes use `preview <method>` followed by `execute <plan-id>`. Preview captures the outbound request without sending it; execution re-derives and matches its hash. Plans expire after 15 minutes and are single use. Secrets and DELETE operations remain denied unless the operator lifts the relevant policy in `.env`. `forge.php policy` reports the effective boundary.

Project ask rules match visible command text, including quoted script paths. They do not resolve arbitrary aliases or dynamically constructed commands. Use the documented CLI invocations.

- **Surface-then-approve**; the canonical target is relayed and approved before execution.
- **Logs are scrubbed** — deployment and server logs may carry secrets; they're scrubbed before relay and before persistence.
- **`.env` stays off the shell** — there is no `Bash(*TOKEN*)` substring deny. `Bash(cat .env*)` is a seeded native deny. Credential state is checked with `forge.php check`, never by reading `.env`.

---

## Configure it

| Key | Description |
|-----|-------------|
| `FORGE_API_TOKEN` | Laravel Forge API token, in the gitignored `.env` |

Everything else — model, heartbeat, idle behavior, per-routine model — is core, tuned with `/hermit-settings`: see core's [Configure it](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/README.md#configure-it) and [Tips & tuning](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/README.md#tips--tuning).

---

## Architecture

`forge.php` is a pure PHP dispatch script the agent calls directly via Bash. The `laravel/forge-sdk` v4 handles all HTTP — no hand-rolled API client, no bun CLI, no bridge process. The vendor tree is **not committed** — hatch runs `composer install --no-dev` into `.hermit/forge-runtime/` (persistent, bind-mounted in Docker, isolated from your app's own `composer.json`/`vendor/`).

---

## Requirements

- `hermitd` ≥1.3.3 (core)
- PHP 8.5+ with `ext-json` and `ext-curl`
- Composer (for the SDK install at hatch time)

**Docker**: targets Ubuntu 26.04 LTS base (ships PHP 8.5 natively). Requires the core base bump to 26.04.

---

## Credits

- Built on [`hermitd`](https://github.com/gtapps/hermitd) — session lifecycle, proposals, routines, memory, cost tracking
- Uses the official [`laravel/forge-sdk`](https://github.com/laravel/forge-sdk) PHP v4 and the [Laravel Forge API](https://forge.laravel.com/api-documentation)

## License

[MIT](LICENSE)
