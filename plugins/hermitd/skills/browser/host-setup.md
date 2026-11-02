# Managed browser on hosts

Public browsing defaults on for tmux and interactive hermits. Hatch downloads the pinned managed binary and Chrome in the background; an existing hermit downloads on first use. The managed command is the `browser-agent.ts` wrapper named in `SKILL.md`, and it never replaces or shadows an operator-installed `agent-browser`. To decline, use `/hermitd:hermit-settings browser`.

For missing Linux/WSL2 packages, Chrome libraries or a sandbox blocker, ask the operator to run from the project root in their host terminal:

```bash
hermitd run browser-host
```

This command installs Xvnc, openbox and unzip using apt-get, dnf or pacman as appropriate. Chrome library setup uses the managed binary with a throwaway HOME; on pacman the missing libraries from `ldd` are printed for manual installation. On hosts restricting unprivileged user namespaces, it installs the scoped AppArmor profile and reloads AppArmor. The operator answers sudo in their terminal; the hermit never handles a password or runs as root. Without sudo, follow the exact administrator commands printed by the script.

Chrome keeps its own sandbox. If Claude Code’s Bash sandbox is enabled, the operator adds `bun */scripts/browser-agent.ts *` to `sandbox.excludedCommands` using [Claude Code sandbox configuration](https://code.claude.com/docs/en/sandboxing). Never write `sandbox.*` from hatch, browser setup or a task, and never add Chrome’s sandbox-disabling flag.

The always-on tmux display starts at boot once packages exist and the browser is enabled. Each hermit has its own display, Unix socket and private profile. Run the same host command after missing prerequisites are installed to start it now. Interactive hermits support anonymous public work but do not run a takeover display. macOS supports the managed anonymous browser; use configured Claude in Chrome for the operator’s account, with no phone takeover.

Phone takeover on Linux/WSL2 also needs `browser.admins`, Tailscale on the host and phone, and the declared handback monitor. Follow [setup.md](setup.md). The host command skips Tailscale entirely when admins are unset. Links use `browser.host` and `browser.port` from config. On Docker, it requests a rebuild first if the image lacks the managed-browser marker.

Use a dedicated host account. Any local user can reach Chrome’s debugging port and forge the viewer’s loopback login header; Xvnc runs without `-auth`. The metadata URL refusal is a guard, not containment. The Linux phone test remains a manual pre-merge gate; macOS and WSL2 have not been live-verified.
