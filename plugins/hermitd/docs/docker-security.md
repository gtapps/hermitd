# Docker Security — Advanced Hardening

`/hermitd:docker-security` is an opt-in advanced wizard for hermit operators who want stronger container isolation than the v1.0.26 baseline (`cap_drop: ALL`, `no-new-privileges`, `pids_limit: 2048`). It applies a `docker-compose.security.yml` overlay alongside the base compose file — never modifying it. The `hermitd-docker` wrapper auto-detects the overlay and chains it onto every command.

> **Trust model.** Installing a plugin runs that plugin's hooks and skills with the same authority as hermit. The hardening here reduces what a *compromised* plugin can do to the host kernel and your local network — it does not vet the plugin's intent, sandbox its file access within the project, or prevent it from acting on your behalf via the agent. A malicious or careless plugin still runs as you. See [Plugin Security](security.md#plugin-security).

## When to run it

- You run hermit on a home or office machine alongside HA, NAS, printer, personal laptops, etc. (LAN containment is the headline gain.)
- You're worried about an injected prompt or a compromised plugin exfiltrating data via DNS or scanning your local network.
- You want kernel-level guarantees on top of the agent-level deny patterns.

## When *not* to run it

- You use `docker.network_mode: "host"` and need host-bound services to remain reachable. The wizard will hard-skip the LAN containment prompt; the other toggles still apply.
- You run an arbitrary dev workflow that hits many third-party domains (e.g. multiple package ecosystems beyond npm/pypi/github). The strict DNS allowlist will break things until you tune it. Use **log-only mode** instead and tune over a few days before flipping to enforce.

## Managed browser

New Docker setups include a browser unless `docker.browser` is false. Full parallel use needs 4 GiB; the resource wizard defaults to `4g`. Docker Desktop's VM and the WSL 2 VM each default to 50% of host memory shared by all containers, so an 8 GiB host needs that limit raised in Docker Desktop's Resources settings or `.wslconfig`.

DNS enforce mode limits browser name lookups to the allowlist. It does not contain the browser: a page can fetch a public IP directly, the same limitation as `curl`. Chrome renders arbitrary pages with `--no-sandbox` beside the agent's credentials. This adds no vault or network filter. Tailnet peers were not tested; `100.64.0.0/10` is not in netguard's drop list.

## What each toggle does

| Toggle | What it does | Real teeth? |
|--------|--------------|-------------|
| **LAN containment + DNS policy** (Prompt 1) | Spins up a `hermit-netguard` Alpine sidecar with nftables + dnsmasq. Hermit shares the sidecar's network namespace via `network_mode: "service:hermit-netguard"`. nftables drops RFC1918 + link-local egress AND redirects all egress :53 to local dnsmasq for actual DNS-policy enforcement. | **Yes — categorical.** Today: a compromised hermit on your home network can scan your router, NAS, HA, printer, etc. After: it cannot. |
| **Resource bounds + kernel hygiene** (Prompt 2) | `mem_limit` / `cpus` caps + a network sysctl bundle (`accept_redirects=0`, `accept_source_route=0`, …). Sysctls placed on the netns owner: hermit-netguard if Prompt 1 is on, hermit otherwise. Sysctls **omitted entirely** in `network_mode: host` — Docker rejects them. | Resource caps are hygiene, not a security primitive. Sysctls block exotic ICMP-redirect / source-routing tricks. |
| **Boot-time plugin install audit log** (Prompt 3) | The entrypoint appends a JSONL line to `.hermit/state/plugin-installs.jsonl` for every `claude plugin install` it performs (hermit core, channels, recommended plugins). | Cheap paper trail, not a security primitive on its own. **Honest scope:** post-boot installs run by the operator via tmux are NOT captured. **Empty-log expectation:** the log only grows when an install actually fires — on subsequent boots when the marketplace + plugin set is unchanged, the entrypoint short-circuits the install path and writes nothing. An empty log on a boot where nothing changed is normal, not a failure. |

## Documented limitations

The wizard makes the container *meaningfully harder to abuse*. It does not make it bulletproof. Operators should know the gaps:

- **Public-IP egress is unconstrained.** A compromised process can still `connect()` to a hardcoded public IP and skip DNS entirely. The DNS policy makes off-the-shelf C2 / exfil that uses domains harder, but doesn't close direct-IP egress. v1.1 may add nftset-driven IP allowlisting (dnsmasq populates an `nftset` of resolved-and-allowed IPs; nftables defaults to deny on output).
- **Docker's default bridge (172.17.0.0/16) is dropped** by the LAN block — it sits inside `172.16.0.0/12`. Operators with adjacent Compose stacks must add carve-outs for the relevant bridge IPs (Prompt 1b "Extra LAN carve-outs").
- **Compose service-name DNS doesn't work through dnsmasq** — Compose's embedded resolver at 127.0.0.11 isn't an upstream. Operators with adjacent services like `db`, `cache`, etc. must add per-service-name lines to the allowlist:
  ```
  server=/db/127.0.0.11
  ```
  Edit `.hermit/docker/dnsmasq.allowlist`, then `hermitd-docker down && hermitd-docker up` (restarting only the sidecar leaves hermit with stale resolver state until hermit itself is bounced).
- **mDNS / `.local`** doesn't resolve through dnsmasq. Services must be referenced by IP address (with a LAN carve-out) rather than `.local` hostnames.
- **Host-bound services unreachable in bridge+containment mode** — `localhost`/`127.0.0.1` on the host is only reachable when `network_mode: host`. Operators wanting both LAN containment AND host-bound access need to refactor their host service to bind on the bridge IP and add a carve-out for that IP.
- **Sidecar crash isolates hermit** — because hermit shares hermit-netguard's network namespace, if the sidecar dies hermit loses *all* networking until you bring it back up. The sidecar has `restart: unless-stopped` and a fail-safe entrypoint (loads-rules-or-tail-stay-up rather than crash-loop), but a misconfigured `nftables.conf` can still strand hermit. If this happens, `docker compose -f docker-compose.hermit.yml -f docker-compose.security.yml logs hermit-netguard` will tell you what went wrong.
- **Fleet mesh weakens sibling isolation.** Every mesh container shares a PID namespace, so it can see and signal every other hermit's processes. The shared `sessions/` volume also holds every hermit's peer auth key, so a compromised hermit can message any sibling. Fleet mesh is for hermits on one host only; `isolatePeerMachines` remains unaffected.

## How to run it

1. Run `/hermitd:docker-security` in Claude Code.
2. Answer each of the 3 prompts. The wizard will:
   - Detect host-network mode and gate Prompt 1 / Prompt 2 sysctls accordingly.
   - Scan installed fleet plugins (`hermitd-homeassistant`, `hermitd-fitness`, etc.) for declared `## Docker network requirements`. Surface their domain/LAN suggestions for per-entry confirmation.
   - Render `docker-compose.security.yml` and (if Prompt 1) the `.hermit/docker/{Dockerfile.hermit-netguard,netguard-entrypoint.sh,nftables.conf,dnsmasq.allowlist}` files.
   - Bring the container down and back up so the new settings take effect (Docker only applies `cap_drop`, `network_mode`, etc. at container creation, not on `restart`).
   - Run a verification pass and print a per-toggle pass/fail table.
3. Re-run the wizard at any time to change toggles. Answer No to a prompt to disable that toggle.

## Verifying it's active

The wizard runs verification automatically. To re-verify later from the host:

```bash
hermitd docker bash -c 'sh -s' <<'VERIFY_EOF'
echo "=== Baseline ==="
grep -E '^Cap(Eff|Bnd)' /proc/self/status            # both 0000000000000000
grep NoNewPrivs /proc/self/status                    # NoNewPrivs: 1
echo "pids.max: $(cat /sys/fs/cgroup/pids.max)"      # 2048

echo "=== LAN containment (when on) ==="
bun -e '
const s = require("net").connect({ host: "192.168.1.1", port: 22, timeout: 2000 });
s.on("connect", () => { console.error("connected"); process.exit(0); });
s.on("timeout", () => { console.error("timed out"); process.exit(1); });
s.on("error", (e) => {
  console.error(e.code === "ECONNREFUSED" ? "refused"
    : e.code === "ENETUNREACH" || e.code === "EHOSTUNREACH" ? "Network is unreachable"
    : String(e));
  process.exit(1);
});
' 2>&1 \
  | grep -qE 'timed out|refused|Network is unreachable' && echo "OK"

echo "=== DNS policy (enforce mode) ==="
getent hosts api.anthropic.com >/dev/null && echo "allow OK"
bun -e 'require("dns").lookup("example.com", (e) => { if (e) { console.error(e.code === "ENOTFOUND" ? "Name or service not known" : String(e)); process.exit(1); } console.log("resolved"); });' 2>&1 \
  | grep -q 'Name or service not known' && echo "block OK"

echo "=== Resource bounds + sysctls (when on, applicable) ==="
cat /sys/fs/cgroup/memory.max
cat /proc/sys/net/ipv4/conf/all/accept_redirects     # 0 if sysctls active
VERIFY_EOF
```

Or use `/hermit-doctor` — the `docker-security` check flags drift between declared posture and the rendered overlay.

## Tuning the DNS allowlist

In **log-only mode**, dnsmasq logs every queried domain (allowed or not — log-only does not block) to the container's stdout. Read it via:

```
docker compose -f docker-compose.hermit.yml \
               -f docker-compose.security.yml logs hermit-netguard
```

In **enforce mode**, the same command surfaces NXDOMAIN denials. Decide which domains to allow, then:

1. Edit `.hermit/docker/dnsmasq.allowlist`. Add lines like:
   ```
   server=/example-vendor.com/1.1.1.1
   ```
2. Restart hermit and the sidecar:
   ```
   hermitd-docker down && hermitd-docker up
   ```
   (Restarting only `hermit-netguard` leaves `hermit` with stale resolver/conntrack state — DNS fails for all domains until hermit itself is bounced.)
3. When the log goes quiet, re-run `/docker-security` and switch from "Yes — recommended (log-only)" to "Yes — strict (enforce)".

The wizard does not auto-promote blocked domains. Manual review keeps the trust boundary at the operator.

**⚠️ Re-running the `/docker-security` wizard regenerates `dnsmasq.allowlist` from scratch** (from your fleet/additional domain selections only) and **erases any hand-added `address=` lines**. Back up the file first if you've added static records below.

**Pinning an internal/private hostname (e.g. Tailscale MagicDNS) to an IP:** add a static record —
```
address=/internal-host.example/10.0.0.5
```
— above the `address=/#/` catchall, then apply it with `hermitd-docker down && hermitd-docker up` (restarting `hermit-netguard` alone leaves `hermit` with stale resolver state). This works in both enforce and log-only mode: log-only extracts and honors static `address=` records while still forwarding everything else (block-nothing preserved); enforce loads the file as-is. `extra_hosts` on the `hermit` service is **not** a usable alternative here — hermit runs with `network_mode: "service:hermit-netguard"`, and Docker rejects `extra_hosts`/`--add-host` outright on any container sharing another container's network namespace.

## GitHub CLI authentication {#gh-cli-authentication}

`gh` is pre-installed in the hermit Docker baseline image. By default it runs anonymously — fine for read-only public-repo operations, but subject to GitHub's unauthenticated rate limit (60 req/hr per IP).

To authenticate, add a GitHub PAT to your `.env` file:

```
HERMIT_GH_TOKEN=ghp_yourpersonalaccesstoken
```

The Compose template maps `HERMIT_GH_TOKEN` to `GH_TOKEN` inside the container, which `gh` reads natively. Restart the container to pick up the change:

```
hermitd-docker down && hermitd-docker up
```

Verify with `hermitd-docker bash -c 'gh auth status'`.

**Why `HERMIT_GH_TOKEN` instead of `GH_TOKEN` directly?** Hermit uses `HERMIT_*` as the namespace for operator-facing credentials so that future runtime shims — for example, auto-minting a short-lived install token from `HERMIT_GH_APP_*` credentials (mirroring how `hermit-scribe` works) — can swap the token source transparently. The operator-facing var name stays stable; only the internal wiring changes.

**Netguard note:** No allowlist entry is needed for GitHub API calls. The existing `server=/github.com/` rule in `dnsmasq.allowlist` already covers `api.github.com` and all other `*.github.com` subdomains — dnsmasq's `server=/<domain>/` syntax matches a domain and all its subdomains.

## Reversal

Two ways:

1. **Through the wizard** (preferred — keeps config and overlay consistent): re-run `/hermitd:docker-security` and answer No to every prompt. The wizard removes `docker-compose.security.yml`, clears `docker.security.*` from `config.json`, and offers to restart the container.
2. **By hand**: `rm docker-compose.security.yml` and run `hermitd-docker down && hermitd-docker up`. The wrapper no-ops on the overlay's absence. This leaves `docker.security.*` in `config.json` (which `/hermit-doctor` will warn about — re-run the wizard to reconcile).

To reverse just one toggle: re-run the wizard, answer Yes to the toggles you still want and No to the one you're disabling.

## Design rationale

A few decisions that operators occasionally ask about:

**Why one combined sidecar.** nftables and dnsmasq share the same network namespace by design — the port-53 redirect rule points to local dnsmasq. Separating them would require careful coordination and provides no operational benefit. Single failure domain, single image to maintain, one health signal.

**Why the dnsmasq UID exemption.** dnsmasq's own upstream queries to `1.1.1.1:53` would otherwise hit the port-53 redirect rule and loop back to itself, breaking all DNS resolution. The `meta skuid != <DNSMASQ_UID>` rule in `nftables.conf` exempts dnsmasq's outbound DNS so it can actually resolve.

**Why the dnsmasq UID is hardcoded.** Alpine's `dnsmasq` package consistently ships `dnsmasq` as uid 100 (its `apk` post-install runs `adduser -u 100 -D -H -s /sbin/nologin dnsmasq`). The wizard renders `100` directly into `nftables.conf` — no probe step. If a future Alpine release ever changes this, the netguard sidecar's fail-safe entrypoint holds the netns open instead of crash-looping (`tail -f /dev/null` after rule-load failure), and the operator can `docker exec hermit-netguard getent passwd dnsmasq` to grep the live UID and update the rendered `nftables.conf` by hand.

## For plugin authors — declaring network requirements

Fleet plugins can declare their network requirements so `/docker-security` surfaces them as pre-checked additions during Prompt 1's fleet-aware seeding sub-step.

In the plugin's `skills/hatch/SKILL.md` or a `DOCKER.md` at the plugin root, add:

```markdown
## Docker network requirements

### Domains (DNS allowlist)
- api.example.com
- www.example.com

### LAN allowlist suggestions
- ASK_OPERATOR_FOR_HA_IP    # special token: wizard prompts operator for the IP
```

Validation: domain regex `^[a-z0-9][a-z0-9.-]+$`; CIDRs validated as IPv4. The token `ASK_OPERATOR_FOR_*_IP` triggers an Other-field prompt for the IP. Plugins without this section contribute nothing — backward compatible.

See [Creating Your Own Hermit](creating-your-own-hermit.md#docker-network-requirements) for the full contract.

## Troubleshooting

### `conflicting options: port publishing and the container type network mode`

Your `docker-compose.hermit.yml` has a `ports:` block on the `hermit` service. With LAN containment on, hermit joins `hermit-netguard`'s network namespace — Docker forbids port publishing on a container that joins another container's netns. Only the netns owner (`hermit-netguard`) can publish ports.

**Fix:** Re-run `/hermitd:docker-security`. The wizard detects the ports and offers to move them to `hermit-netguard`. When prompted, delete the `ports:` block from `docker-compose.hermit.yml`. The wizard hard-gates `hermitd-docker up` until that's done, so a partial state can't reach the daemon.

### `invalid pool request: Pool overlaps with other one on this address space`

The overlay's `hermit-net` subnet (`172.28.0.0/24` by default) collides with another Docker network on the host. This happens most often when a second hermit project (each project gets its own `<proj>_hermit-net` network name, but subnets are host-global) or an unrelated Compose stack already claims that range.

**Fix:** Re-run `/hermitd:docker-security`. The wizard now scans all Docker networks on the host, excludes this project's own `hermit-net` via Compose labels, and auto-picks the first free /24 from a candidate list (`172.28-31`, then `10.244-247`). If all candidates are taken it prompts for a custom CIDR.

The new `docker.security.network.subnet` field in `config.json` records the chosen subnet. Running `/hermit-doctor` from the host will flag a WARN before the next `hermitd-docker up` if the stored subnet has since been claimed by another network — the scheduled in-container doctor run can't perform this check (no docker CLI inside the container), so it reports `ok` instead.
