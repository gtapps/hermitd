---
name: docker-security
description: Opt-in advanced Docker security hardening beyond the docker-setup baseline — LAN containment with DNS policy, resource bounds with kernel-hygiene sysctls, and a boot-time plugin install audit log. Applied as a reversible docker-compose overlay (does not touch the base compose file) and verified against the live container. Run after /docker-setup; requires bridge networking.
disable-model-invocation: true
---

# Docker Security

Advanced hardening for already-deployed hermit containers. Each toggle is opt-in, presented with honest cost/benefit framing, and applied as a `docker-compose.security.yml` overlay that the `hermitd-docker` wrapper auto-detects. Reversal: re-run and answer No to every prompt, or delete `docker-compose.security.yml` directly.

**Tone:** Honest about tradeoffs. Tell operators what each toggle does AND does not protect. Do not oversell.

Each step's commands depend on the previous step's answer, so run them in order.

Templates live in `${CLAUDE_SKILL_DIR}/../../state-templates/docker/security/`.

## Trust model framing (read to operator at the start of step 2)

> Installing a plugin runs that plugin's hooks and skills with the same authority as hermit. The container hardening here reduces what a *compromised* plugin can do to the host kernel and your local network — it does not vet the plugin's intent, sandbox its file access within the project, or prevent it from acting on your behalf via the agent. A malicious or careless plugin still runs as you.
>
> **Honest limitation:** DNS policy below blocks domain-based exfil/C2 but cannot stop direct-IP egress to a hardcoded public address.

## Plan

### 0. Refuse to run inside the hermit container

This skill is host-only — it writes a `docker-compose.security.yml` overlay on the host and recreates the container with stronger isolation.

Run: `[ -f /.dockerenv ] || [ -f /run/.containerenv ] && echo container || echo host`

If the output is `container`, **stop immediately** — do not proceed to step 1. Print:

> This skill writes a `docker-compose.security.yml` overlay on the host and recreates the container with stronger isolation. Run it from your host shell in the project root. To inspect the live security posture *inside* the running container, run `/hermitd:hermit-doctor` — it includes a `docker-security` check.

### 1. Prerequisites

1. Read `.hermit/config.json`. If missing: "Run `/hermitd:hatch` first." Stop.
2. Verify `docker-compose.hermit.yml` exists at the project root. If missing: "Run `/hermitd:docker-setup` first." Stop.
3. **Docker daemon check**: run `timeout 10s docker info >/dev/null 2>&1`. If it fails or times out: tell the operator "Docker daemon is not reachable or timed out. Start Docker before re-running `/docker-security`." Stop.
4. Read `docker.network_mode` from config (default: `"bridge"`). If `"host"`, set `HOST_NETWORK_MODE=true` and surface to operator: "Detected `network_mode: host` in your config. The LAN containment toggle (Prompt 1) will be skipped — it would replace host mode and break your HA / host-bound service access. Resource bounds (Prompt 2) will not apply network sysctls in host mode either; Docker rejects them and the container would fail to start."
5. **Detect hermit ports**: run `timeout 10s docker compose -f docker-compose.hermit.yml config --format json 2>/dev/null` and parse `.services.hermit.ports`. Store as in-memory `detected_hermit_ports` (array of long-form Compose port objects: `{target, published, host_ip, protocol, mode}`). If the command fails or returns no JSON, fall back to `grep -n '^\s*ports:' docker-compose.hermit.yml` and set `detected_hermit_ports_unparsed=true` if found. Either way, a non-empty result means ports are present.
6. Check whether the container is currently running: `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Service}}' 2>/dev/null | grep -x hermit`. If absent: tell the operator "Container is not running. The wizard will still write the overlay; you'll see the live verification only after starting the container with `hermitd-docker up`."
7. Read current `docker.security.*` from config.json. Also read `sandbox.enabled` from the target settings file (same `hatch_target` routing as hatch/docker-setup: `hatch_target == "local"` → `.claude/settings.local.json`; else → `.claude/settings.json`) — display only, hermit does not configure this key. Print a "current posture" summary. Example:

   ```
   Current security posture:
     LAN containment: off
     Resource bounds: off
     Audit log: off

   Baseline (always on):
     cap_drop: ALL, no-new-privileges, pids_limit: 2048

   Sandbox (bash tool isolation, operator-managed via /sandbox):
     enabled: true  (or: false / not configured)
   ```

### 2. Trust model framing

Print the trust-model paragraph from the top of this file (the blockquote). Then continue.

### 3. Prompt 1 — LAN containment + DNS policy

If `HOST_NETWORK_MODE` is true, **do not present this prompt**. Tell the operator: "Skipping LAN containment — incompatible with `network_mode: host`. Run `/hermitd:docker-setup` to switch to bridge mode if you want this hardening." Continue to step 4.

Otherwise, ask with `AskUserQuestion` (header: `"LAN containment"`):

```
question: "Add LAN containment with DNS policy? (firewall sidecar + DNS allowlist)"
options:
  - label: "Yes — recommended (LAN block + DNS log-only)"
    description: "Blocks RFC1918 + cloud metadata. DNS in log-only mode: allows everything, logs blocked queries for tuning."
  - label: "Yes — strict (LAN block + DNS enforce)"
    description: "Same LAN block. DNS returns NXDOMAIN for any domain not on the allowlist."
  - label: "No"
    description: "Skip this toggle."
```

Map: `"Yes — recommended"` → `dns_mode: "log-only"`. `"Yes — strict"` → `dns_mode: "enforce"`. `"No"` → skip to step 4.

#### 3-pre. Port conflict handling (only if a "Yes" option was selected above)

If the operator selected a "Yes" option AND `detected_hermit_ports` is non-empty (or `detected_hermit_ports_unparsed=true`), surface a follow-up `AskUserQuestion` (header: `"Port publishing"`) immediately:

```
Your docker-compose.hermit.yml publishes ports on the hermit service:
  - "3000:3000"        ← list each port if parsed, or "(port block detected)" if unparsed
  ...

LAN containment requires hermit to share hermit-netguard's network namespace.
Docker forbids `ports:` on a container that joins another container's netns —
only netguard (the netns owner) can publish ports.
```

Options:
- `"Move ports to netguard (recommended)"` — render the same `ports:` block on `hermit-netguard` in the overlay. Persist to `docker.security.network.publish_ports`. After overlay is written (step 6), show a diff and prompt the operator to delete the `ports:` block from `docker-compose.hermit.yml` themselves — the wizard does not modify the base file.
- `"Skip LAN containment (keep ports on hermit)"` — clear the LAN containment selection (treat as if operator answered No above). Set `lan_containment_skipped_due_to_ports=true`. Continue to step 4.
- `"Cancel"` — print "Re-run /docker-security after deciding how to handle your port publishing. See docs/docker-security.md for guidance." Exit. Write nothing.

**If operator chose "Skip LAN containment"**: proceed to step 4 without any LAN containment config. Step 9 final-report notes: "LAN containment skipped — docker-compose.hermit.yml has a `ports:` block on hermit that is incompatible with `network_mode: service:hermit-netguard`."

#### 3a. Fleet-aware domain seeding

Scan installed fleet plugins. From the host:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-siblings.ts "$(pwd)" --role siblings
```

It emits a JSON array of the project-or-local + enabled hermit siblings (each carrying `plugin`, `installPath`), already excluding user-scope, disabled, cross-project, and `hermitd` itself.

For each entry:

1. Locate the plugin's installed root using the `installPath` field from the JSON.
2. Read `<plugin>/skills/hatch/SKILL.md` and look for a `## Docker network requirements` heading. Also check `<plugin>/DOCKER.md`. Stop at the next `##` heading.
3. Within that section, parse:
   - `### Domains (DNS allowlist)` — bullet entries are domain names. Validate against `^[a-z0-9][a-z0-9.-]+$`. Reject failing entries with a warning.
   - `### LAN allowlist suggestions` — bullet entries are either IPv4 CIDRs (validate with regex) OR the special token `ASK_OPERATOR_FOR_HA_IP` (or other `ASK_OPERATOR_FOR_*_IP` patterns). Reject failing CIDRs.
4. Track provenance: each entry remembers which plugin contributed it.

If the deduped fleet list is non-empty, present plain text first:

```
Fleet plugins request these network exceptions:
  api.strava.com           — hermitd-fitness (DNS)
  www.strava.com           — hermitd-fitness (DNS)
  ASK_OPERATOR_FOR_HA_IP   — hermitd-homeassistant (LAN, will prompt for IP)
```

Then ask once with `AskUserQuestion` (header: `"Fleet network entries"`):

- `"Include all"` (Recommended)
- `"Pick each"`
- `"Skip all"`

On `"Pick each"`: loop through each entry with a 2-option `AskUserQuestion` (`"Include"` / `"Skip"`).

For every confirmed `ASK_OPERATOR_FOR_HA_IP` (or similar): immediately follow up with `AskUserQuestion` (header: `"<plugin> IP"`) — Other field accepting an IPv4 address or CIDR. Validate. Re-prompt on invalid. Replace the token with the typed value.

Confirmed entries are added to in-memory `fleet_lan_allowlist` and `fleet_domains` for step 6.

If the fleet list is empty: skip silently.

#### 3b. Extra LAN carve-outs

`AskUserQuestion` (header: `"Extra LAN carve-outs"`):

- `"None"`
- `"Add IPs/ranges"` (Other field, comma-separated, IPv4 CIDR validated; re-prompt on invalid)

Persist to `lan_allowlist` (combined with `fleet_lan_allowlist`).

#### 3c. Extra domains

`AskUserQuestion` (header: `"Extra domains"`):

- `"None (use defaults + fleet)"`
- `"Add domains"` (Other field, comma-separated, domain regex validated; re-prompt on invalid)

Persist to `additional_domains` (combined with `fleet_domains`).

#### 3d. Persist Prompt 1 selections

```json
docker.security.network = {
  "enabled": true,
  "dns_mode": "log-only" | "enforce",
  "lan_allowlist": ["192.168.1.50", ...],
  "additional_domains": ["api.strava.com", ...]
}
```

### 4. Prompt 2 — Resource bounds + kernel hygiene

`AskUserQuestion` (header: `"Resource bounds"`):

```
question: "Set memory and CPU caps + network kernel hardening sysctls?"
options:
  - label: "Yes — defaults (mem 4g, cpus 2.0, sysctl bundle)"
    description: "Caps a runaway agent's resource cost; sysctls disable ICMP redirect / source-routing tricks."
  - label: "Yes — custom mem/cpu"
    description: "Pick your own memory and CPU limits."
  - label: "No"
    description: "Skip this toggle."
```

On `"Yes — custom mem/cpu"`: follow up with `AskUserQuestion` (header: `"Custom limits"`) — Other field accepting two values, comma-separated. Validate `mem` against `^[0-9]+(g|m)?$`, `cpus` against `^[0-9.]+$`. Re-prompt on invalid.

**Sysctl placement note**:
- If `HOST_NETWORK_MODE` is true: silently set `sysctls_enabled = false` regardless of choice and tell the operator: "Network sysctls cannot be applied with `network_mode: host` — Docker rejects them. Resource bounds (mem/cpus) will still apply if you said Yes."
- Otherwise: `sysctls_enabled = true`.

Persist:

```json
docker.security.resources = {
  "enabled": true,
  "mem_limit": "4g",
  "memswap_limit": "4g",
  "cpus": 2.0,
  "sysctls_enabled": true|false
}
```

### 5. Prompt 3 — Plugin install audit log

`AskUserQuestion` (header: `"Audit log"`):

```
question: "Record every boot-time plugin install to a JSONL audit log?"
options:
  - label: "Yes — recommended"
    description: "Appends one JSONL line per `claude plugin install` performed by the entrypoint to .hermit/state/plugin-installs.jsonl. Honest scope: post-boot installs run via tmux are not captured. The log is empty until something actually installs — on subsequent boots when the marketplace + plugin set is unchanged, no install fires and no entry is written. That's normal, not a failure."
  - label: "No"
    description: "Skip this toggle."
```

Persist `docker.security.audit.plugin_installs` accordingly.

### 6. Render overlay

**Before rendering — preserve `publish_ports` across reruns:**
Read `docker.security.network.publish_ports` from the existing config.json (if present). Keep this as `persisted_publish_ports`. In the current wizard run:
- If the operator chose "Move ports to netguard": replace `persisted_publish_ports` with the newly detected ports from step 5 (prerequisites).
- If no base ports were detected AND the operator did not visit the port-conflict flow: keep `persisted_publish_ports` unchanged (the operator already deleted the base block; do not lose the netguard mapping).
- If the operator chose "Skip LAN containment (keep ports on hermit)": set `persisted_publish_ports = []` (LAN containment is off; ports stay on hermit in the base file).

**All-off branch — warn before deletion if `publish_ports` was set:**
Otherwise (all toggles off): before deleting the overlay, check if `persisted_publish_ports` is non-empty. If so, surface:

```
Heads up: turning all toggles off will remove the overlay, including these
ports that hermit-netguard currently publishes:
  - "3000:3000"
  ...

If you previously deleted the `ports:` block from docker-compose.hermit.yml,
you'll need to re-add it there before bringing the container back up — the
overlay won't be there to publish them.
```

Then `AskUserQuestion` (header: `"Confirm all-off"`):
- `"Yes — proceed (I'll restore base ports if needed)"`
- `"No — cancel"`

On Yes: continue to overlay deletion, clear `docker.security.*`, tell the operator "All toggles off — overlay removed and config cleared." Skip to step 9.
On No: exit wizard, write nothing.

If `persisted_publish_ports` is empty: proceed directly to deletion without the prompt.

**Subnet auto-detection (only if LAN containment is enabled):**

Run `pick-subnet` — it enumerates occupied Docker subnets, excludes this project's own `hermit-net`, integer-range-checks overlap, walks the 8 fixed /24 candidates, and always exits 0 (probe pattern):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/render-security-overlay.ts pick-subnet <PROJECT_ROOT>
```

It prints `{ "chosen": { "subnet", "gateway", "netguard_ip" } | null, "all_candidates_collide": bool }`.

- If `chosen` is non-null, use it.
- If `all_candidates_collide` is true, `AskUserQuestion` (header: `"Custom subnet"`) with an Other field for an IPv4 /24 CIDR. Validate each answer with one cheap re-run:
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/render-security-overlay.ts pick-subnet <PROJECT_ROOT> --candidate <cidr>
  ```
  `chosen: null` means still colliding or not a /24 — re-prompt. `chosen` set means accepted.

Persist the chosen values to `docker.security.network` (`subnet`, `gateway`, `netguard_ip` from `chosen`), alongside `enabled`, `dns_mode`, `lan_allowlist`, `additional_domains`, `publish_ports`. If LAN containment is not enabled, omit `subnet`, `gateway`, `netguard_ip`.

If at least one toggle is enabled, render the overlay. Otherwise (all-off): handled in the all-off branch above.

#### 6a. dnsmasq UID is hardcoded

Render `100` directly into `nftables.conf` as the dnsmasq UID — no probe step. Rationale and recovery path if Alpine ever changes it: see [docs/docker-security.md#design-rationale](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/docker-security.md#design-rationale).

After the netguard files are rendered (step 6c), the wizard runs an explicit `--no-cache` build of `hermit-netguard` to prevent stale Docker cache artifacts from surviving a hermit upgrade. Do not rely on `hermitd-docker up` to trigger a rebuild.

#### 6b. Render the overlay + nftables + dnsmasq

`render-security-overlay.ts render` derives every `{{PLACEHOLDER}}` (networks block, netguard service with cap_add/healthcheck, `DNS_LOG_ONLY` from `dns_mode`, per-toggle hermit blocks, sysctls placement, ports, LAN rules at the chain-body indent, `DNSMASQ_UID=100`, `server=` domain lines) and fails loud (exit 1, nothing written) if any survives. It writes `docker-compose.security.yml` to the project root, and — only when LAN containment is on — `nftables.conf` + `dnsmasq.allowlist` into `.hermit/docker/`. Pipe the resolved selections:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/render-security-overlay.ts render <PROJECT_ROOT> <<'HERMIT_SEC_JSON'
{
  "network": { "subnet": "...", "gateway": "...", "netguard_ip": "..." },
  "toggles": {
    "lan":       { "enabled": true, "dnsMode": "log-only" | "enforce" },
    "resources": { "enabled": true, "memLimit": "4g", "memswapLimit": "4g", "cpus": 2.0, "sysctlsEnabled": true },
    "audit":     { "enabled": true }
  },
  "publishPorts": [ { "target": 3000, "published": "3000", "protocol": "tcp", "host_ip": "0.0.0.0", "mode": "ingress" } ],
  "lanAllowlist": [...],
  "fleetDomains": [...],
  "additionalDomains": [...]
}
HERMIT_SEC_JSON
```

Notes:
- `network` is required only when `toggles.lan.enabled`. The script places sysctls on netguard when LAN is on, on hermit when LAN is off (Prompt 2 only). `host_ip: "0.0.0.0"` and `mode: "ingress"` (Compose defaults) are omitted from rendered port entries.
- If base ports were detected via the grep fallback (`detected_hermit_ports_unparsed=true`) with no parsed shape, pass `publishPorts: []` and tell the operator: "Could not parse port shapes from the compose config — manually add your `ports:` block to `hermit-netguard` in the rendered overlay and delete it from the base file."
- The script prints `{ "written": [...] }`.

#### 6c. Copy the netguard Dockerfile + entrypoint (only if Prompt 1 enabled)

`render` (6b) already wrote `nftables.conf` + `dnsmasq.allowlist`. Copy the two static netguard files from `state-templates/docker/security/` into `.hermit/docker/`:

- `Dockerfile.hermit-netguard.template` → `Dockerfile.hermit-netguard`
- `netguard-entrypoint.sh.template` → `netguard-entrypoint.sh` (chmod +x)

After both are copied, force a fresh netguard image build:

```bash
timeout 180s docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml build --no-cache hermit-netguard
```

If the build exits non-zero, run `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml logs hermit-netguard --tail=30`, surface the output, and suggest a targeted fix:
- **`apk add` fails** → DNS not reachable at build time; check host network and Docker DNS config (`/etc/docker/daemon.json`)
- **Syntax error in nftables.conf or dnsmasq.allowlist** → read the error line; it usually names the file and line number
- **Port already in use** → a published port in the overlay conflicts; `ss -tlnp | grep <port>` finds the owner
Then stop. Do not proceed to step 6d.

#### 6d. Show diff + confirm

Print a one-screen summary of files written (paths + line counts). Ask `AskUserQuestion` (header: `"Apply"`) — `"Yes — restart container now"` / `"No — I'll restart manually later"`.

On `"No — I'll restart manually later"`: skip to step 9 with the note "Overlay written. Run `hermitd-docker down` then `hermitd-docker up` when ready to apply. Re-run `/docker-security` at any time to verify."

### 7. Restart + smoke test

**Hard gate — re-check base ports before starting:**
Before running `hermitd-docker up`, re-run the step 5 port detection: `timeout 10s docker compose -f docker-compose.hermit.yml config --format json 2>/dev/null | bun -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log((((d.services ?? {}).hermit ?? {}).ports ?? []).length)'`. If the result is non-zero (or the command output from the grep fallback is non-empty) AND `docker.security.network.enabled === true` (LAN containment is on):

Ask with `AskUserQuestion` (header: `"Ports conflict"`):
- `"Auto-fix — I'll remove the \`ports:\` block (backup first)"` (Recommended)
- `"I'll edit it myself — pause here"`

**On "Auto-fix":** Back up the base compose file first: `cp docker-compose.hermit.yml docker-compose.hermit.yml.bak`. Then read `docker-compose.hermit.yml`, locate the `ports:` key under the `hermit:` service, and remove it and all its child lines (keep every other key). Write the file back. Print: "Removed `ports:` block from docker-compose.hermit.yml (backup: docker-compose.hermit.yml.bak). Ports are now published by hermit-netguard via the overlay." Continue to the restart sequence below ("If operator chose to restart now...").

**On "I'll edit it myself":** Print:
```
Cannot start container — docker-compose.hermit.yml still publishes ports on hermit.
Those ports are now published by hermit-netguard via the overlay.
Delete the `ports:` block from docker-compose.hermit.yml, then run:
  hermitd start
```
Stop here. Tell the operator: "Overlay and config have been written — just delete the base `ports:` block first, then run `hermitd start`."

If operator chose to restart now AND container was running before this skill (and the hard gate passed):

1. Run `.hermit/bin/hermitd-docker down`.
2. Run `.hermit/bin/hermitd-docker up` (the wrapper picks up the overlay automatically). The first up will trigger `docker compose build hermit-netguard` if Prompt 1 was enabled — wait for completion (can be 30-60s on first build).
3. Poll `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml ps --status running --format '{{.Service}}'` every 2s for up to 30s; expect `hermit` (and `hermit-netguard` if Prompt 1 enabled). If either is missing after 30s: run `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml logs <missing-service> --tail=30` (substitute `hermit` or `hermit-netguard` per the missing service; omit the service name if both are down), surface output, and suggest:
   - **hermit-netguard won't start** → nftables or dnsmasq config error; read the log for the line number
   - **hermit won't start** → check if the base `ports:` conflict was fully resolved (re-run the hard gate port check above)
   - **Both down** → Docker daemon issue; `docker info` to confirm daemon is healthy
   Then stop.
### 8. Verify

Stream the static verification script into the live container. It is placeholder-free (hardcoded probe values) and uses only tools the hermit base image ships — `bun`, `jq`, `curl`, glibc `getent` (no `python3`, `nc`, or `nslookup`):

```bash
docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml \
  exec -T hermit sh -s < "${CLAUDE_PLUGIN_ROOT}/state-templates/docker/security/verify-security.sh"
```

Surface the output to the operator. Suggest: "Run `/hermitd:hermit-doctor` to also verify the docker-security check shows green."

### 9. Final report

Print a brief summary:

```
docker-security applied — current posture:
  LAN containment:   on  (DNS log-only)  | LAN carve-outs: 192.168.1.50
  Resource bounds:   on  (mem 4g, cpus 2.0)
  Audit log:         on

Reverse: re-run /docker-security and answer No to every prompt, OR
         delete docker-compose.security.yml and re-run hermitd-docker up.

Tune DNS allowlist: edit .hermit/docker/dnsmasq.allowlist,
         then `hermitd-docker down && hermitd-docker up`
         (restart hermit-netguard alone leaves hermit with stale resolver state).
```

## Notes

**Reversal, limitations, DNS allowlist tuning, and design rationale**: see [docs/docker-security.md](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/docker-security.md).
