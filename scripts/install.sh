#!/usr/bin/env bash
#
# hermitd bootstrap.
#
#   curl -fsSL https://gtapps.github.io/hermitd/install.sh | bash
#
# Provisions what a bare box needs (Claude Code, Bun, tmux), registers the
# marketplace and installs the plugin at local scope in the current directory.
# When a controlling terminal is available it then launches Claude Code with
# /hatch after a short countdown (Ctrl+C falls back to printed instructions);
# without one (CI, ssh without -t, provisioning) it prints the instructions.
#
# No flags, no prompts by design. Under `curl | bash` the script itself is on
# stdin, so any `read` from stdin would either hang or eat script text — which
# is why the launch redirects claude's stdin from /dev/tty instead.
#
# Kept bash 3.2 compatible: macOS ships bash 3.2 as /bin/bash, so no associative
# arrays, no `readarray`, no `${var^^}`.

set -euo pipefail

MARKETPLACE="gtapps/hermitd"
PLUGIN="hermitd"
META_URL="https://raw.githubusercontent.com/gtapps/hermitd/main/plugins/hermitd/.claude-plugin/hermit-meta.json"
DOCS_URL="https://github.com/gtapps/hermitd#quick-start"

CLAUDE_WAS_INSTALLED=0   # set when we install Claude Code fresh; drives the closing block

# ---------------------------------------------------------------- output ----

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m+\033[0m %-12s %s\n' "$1" "$2"; }
work() { printf '  \033[34m>\033[0m %-12s %s\n' "$1" "$2"; }
warn() { printf '  \033[33m!\033[0m %-12s %s\n' "$1" "$2"; }
die()  { printf '\n  \033[31mx\033[0m %s\n\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- versioning ----

# ver_ge A B -> exit 0 when A >= B. awk rather than `sort -V`, which BSD sort on
# macOS does not reliably provide. Non-numeric trailers are tolerated: awk's
# `+ 0` turns "251 (Claude" into 251.
ver_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, A, "."); nb = split(b, B, ".")
    for (i = 1; i <= 3; i++) {
      x = (i <= na) ? A[i] + 0 : 0
      y = (i <= nb) ? B[i] + 0 : 0
      if (x > y) exit 0
      if (x < y) exit 1
    }
    exit 0
  }'
}

# Pull one "key": ">=X.Y.Z" out of hermit-meta.json and reduce it to X.Y.Z.
# No jq dependency: the file is small, flat and machine-written.
meta_floor() {
  printf '%s' "$1" \
    | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | tr -cd '0-9.'
}

# ---------------------------------------------------------------- platform ----

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux|Darwin) ;;
    *) die "Unsupported platform: $os. Linux, macOS and Windows via WSL2 only. See $DOCS_URL" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) die "Unsupported architecture: $arch. x64 and arm64 only. See $DOCS_URL" ;;
  esac
  if [ "$os" = "Linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then
    PLATFORM="wsl2-$arch"
  else
    PLATFORM="$(printf '%s' "$os" | tr 'A-Z' 'a-z')-$arch"
  fi
}

# ------------------------------------------------------------------ floors ----

# Read the version floors from the plugin's own manifest so this script cannot
# drift from what doctor-check.ts enforces. A failed fetch is not fatal: absent
# tools are installed at latest, which clears any floor. An already-present but
# stale tool then goes uncaught here and is caught later by /hermit-doctor.
load_floors() {
  local meta
  CLAUDE_FLOOR=""
  BUN_FLOOR=""
  if meta="$(curl -fsSL --max-time 20 "$META_URL" 2>/dev/null)"; then
    CLAUDE_FLOOR="$(meta_floor "$meta" min_claude_code_version)"
    BUN_FLOOR="$(meta_floor "$meta" required_bun_version)"
  fi
  if [ -z "$CLAUDE_FLOOR" ] || [ -z "$BUN_FLOOR" ]; then
    warn "floors" "could not read version floors, skipping version checks"
    CLAUDE_FLOOR=""
    BUN_FLOOR=""
  fi
}

# ------------------------------------------------------------ claude code ----

# `|| true` inside the pipeline: with `set -o pipefail` a claude that exists but
# errors (stale npm wrapper, missing node) would otherwise abort the whole
# installer at the assignment below, silently and with no message.
claude_version() { { claude --version 2>/dev/null || true; } | awk '{print $1}'; }

ensure_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    work "claude" "installing..."
    curl -fsSL --max-time 20 https://claude.ai/install.sh | bash >/dev/null 2>&1 \
      || die "Claude Code install failed. Install it manually, then re-run: https://code.claude.com/docs/en/setup"
    export PATH="$HOME/.local/bin:$PATH"
    CLAUDE_WAS_INSTALLED=1
    command -v claude >/dev/null 2>&1 \
      || die "Claude Code installed but 'claude' is not on PATH. Open a new shell and re-run."
    ok "claude" "$(claude_version)"
    return
  fi

  local v
  v="$(claude_version)"
  [ -n "$v" ] \
    || die "'claude' is on PATH but 'claude --version' failed. Repair or reinstall Claude Code, then re-run: https://code.claude.com/docs/en/setup"
  if [ -n "$CLAUDE_FLOOR" ] && ! ver_ge "$v" "$CLAUDE_FLOOR"; then
    work "claude" "$v is below $CLAUDE_FLOOR, updating..."
    claude update >/dev/null 2>&1 || true
    v="$(claude_version)"
    ver_ge "$v" "$CLAUDE_FLOOR" \
      || die "Claude Code $v is below the required $CLAUDE_FLOOR and 'claude update' did not move it. Update manually, then re-run: https://code.claude.com/docs/en/setup"
  fi
  ok "claude" "$v"
}

# -------------------------------------------------------------------- bun ----

ensure_bun() {
  local v=""
  # `|| true`: the assignment follows the final `&&`, so `set -e` applies to it.
  # A bun on PATH that errors (broken shim, missing glibc) would otherwise abort
  # the installer with no output at all.
  command -v bun >/dev/null 2>&1 && v="$(bun --version 2>/dev/null || true)"

  if [ -z "$v" ] || { [ -n "$BUN_FLOOR" ] && ! ver_ge "$v" "$BUN_FLOOR"; }; then
    work "bun" "installing..."
    curl -fsSL --max-time 20 https://bun.sh/install | bash >/dev/null 2>&1 \
      || die "Bun install failed. It needs 'unzip', which minimal images often lack. Install unzip, or install Bun manually, then re-run: https://bun.sh"
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    v="$(bun --version 2>/dev/null || true)"
    [ -n "$v" ] || die "Bun installed but 'bun' is not on PATH. Open a new shell and re-run."
    # Same re-verification ensure_claude does: an install that exits 0 without
    # replacing a below-floor bun must not be reported as success.
    if [ -n "$BUN_FLOOR" ] && ! ver_ge "$v" "$BUN_FLOOR"; then
      die "Bun $v is still below the required $BUN_FLOOR after install. Install it manually, then re-run: https://bun.sh"
    fi
  fi
  ok "bun" "$v"
}

# ------------------------------------------------------------------- tmux ----

# Best-effort: tmux is only needed for the tmux always-on path. The Docker path
# and `hermitd-start --no-tmux` do not use it, so a box without sudo gets a
# warning rather than a failed install.
ensure_tmux() {
  if command -v tmux >/dev/null 2>&1; then
    ok "tmux" "$(tmux -V 2>/dev/null | awk '{print $2}')"
    return
  fi

  # brew is checked before the sudo gate: it never needs root, so a box with
  # Homebrew but no `sudo` binary should still get tmux.
  if command -v brew >/dev/null 2>&1; then
    work "tmux" "installing..."
    brew install tmux >/dev/null 2>&1 || true
  else
    local sudo=""
    if [ "$(id -u)" != "0" ]; then
      if command -v sudo >/dev/null 2>&1; then
        sudo="sudo"
      else
        warn "tmux" "not installed and no sudo; install it yourself for the tmux always-on path"
        return
      fi
    fi

    work "tmux" "installing..."
    if command -v apt-get >/dev/null 2>&1; then
      $sudo apt-get update -qq >/dev/null 2>&1 || true
      $sudo apt-get install -y tmux >/dev/null 2>&1 || true
    elif command -v dnf >/dev/null 2>&1; then
      $sudo dnf install -y tmux >/dev/null 2>&1 || true
    elif command -v apk >/dev/null 2>&1; then
      $sudo apk add tmux >/dev/null 2>&1 || true
    elif command -v pacman >/dev/null 2>&1; then
      $sudo pacman -S --noconfirm tmux >/dev/null 2>&1 || true
    fi
  fi

  if command -v tmux >/dev/null 2>&1; then
    ok "tmux" "$(tmux -V 2>/dev/null | awk '{print $2}')"
  else
    warn "tmux" "install failed; needed only for the tmux always-on path"
  fi
}

# ------------------------------------------------------------------ plugin ----

install_plugin() {
  # --marketplace adds the marketplace when it is missing and reuses it otherwise.
  work "plugin" "installing at local scope..."
  local out
  if ! out="$(claude plugin install "$PLUGIN" --marketplace "$MARKETPLACE" --scope local 2>&1)"; then
    printf '%s\n' "$out" >&2
    die "Plugin install failed (Claude Code's output above). If it is a git or network error: adding the marketplace clones over git, so this needs 'git' installed and network access to github.com; on macOS a missing Xcode CLT makes git prompt instead of run. Re-run, or install by hand: claude plugin install $PLUGIN --marketplace $MARKETPLACE --scope local"
  fi
  ok "plugin" "hermitd ($(pwd))"
}

# ------------------------------------------------------------ closing block ----

# Credential detection is best-effort. On macOS Claude Code may hold credentials
# in the Keychain rather than on disk, so a false "not logged in" is possible;
# the wording below is written to stay true either way.
has_credentials() {
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && return 0
  [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ] && return 0
  return 1
}

rule() { printf '  \033[2m%s\033[0m\n' "─────────────────────────────────────────────────"; }

closing_block() {
  printf '\n'
  rule

  if [ -f ".hermit/config.json" ]; then
    say "Prerequisites set. This folder is already hatched, so update instead:"
    printf '\n'
    say "    .hermit/bin/hermitd-update"
    printf '\n'
    rule
    return
  fi

  say "Prerequisites set. Time to hatch your agent:"
  printf '\n'
  # Not mutually exclusive: a Claude Code this script just installed is by
  # definition logged out, so the fresh-install path needs the login line too.
  if [ "$CLAUDE_WAS_INSTALLED" = "1" ]; then
    say "    exec \$SHELL"
  fi
  if ! has_credentials; then
    say "    claude          # not logged in on this machine? /login first"
  fi
  say "    claude \"/hermitd:hatch\""
  printf '\n'
  if [ "$CLAUDE_WAS_INSTALLED" = "1" ]; then
    say "The first reloads your shell so \`claude\` is on PATH."
    printf '\n'
  fi
  rule
}

# The countdown launch needs two things: /dev/tty must open (no controlling
# terminal in CI / `ssh host 'curl|bash'` / provisioning), and stdout must
# still be a terminal — claude's interactive UI writes to fd 1, so a
# redirected run (`bash install.sh > install.log`, `... | tee`) must take the
# printed fallback instead of streaming a TUI into the file.
can_launch() {
  { : </dev/tty; } 2>/dev/null || return 1
  [ -t 1 ]
}

hatch_countdown() {
  printf '\n'
  rule
  say "Prerequisites set. Time to hatch your agent."
  if [ "$CLAUDE_WAS_INSTALLED" = "1" ]; then
    say "(afterwards, open a new shell so 'claude' is on your PATH)"
  fi
  if ! has_credentials; then
    say "(you'll be asked to log in first)"
  fi
  printf '\n'
  trap 'printf "\n"; trap - INT; closing_block; exit 0' INT
  printf '  Launching Claude Code in 3… '
  sleep 1; printf '2… '
  sleep 1; printf '1…   (Ctrl+C to do it later)\n'
  sleep 1
  trap - INT
  exec claude "/hermitd:hatch" </dev/tty
}

# ------------------------------------------------------------------- main ----

main() {
  printf '\n  \033[1mhermitd\033[0m\n\n'

  detect_platform
  ok "platform" "$PLATFORM"

  load_floors
  ensure_claude
  ensure_bun
  ensure_tmux
  install_plugin

  if [ ! -f ".hermit/config.json" ] && can_launch; then
    hatch_countdown
  else
    closing_block
  fi
}

# Guarded so CI can `source` this file to reuse ver_ge and load_floors without
# re-running the install. Under `curl | bash` BASH_SOURCE is unset and both
# sides resolve to "bash", so the installer still runs.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
