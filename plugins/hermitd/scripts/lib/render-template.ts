// Shared {{PLACEHOLDER}} substitution engine for the docker render scripts.
//
// renderTemplate replaces every `{{NAME}}` occurrence with the supplied value,
// then fails loud if any `{{...}}` token survives — a missing var means the
// caller forgot to derive a placeholder, and shipping a half-rendered
// Dockerfile / compose / nftables file is worse than writing nothing. Callers
// render + validate every file in memory BEFORE touching disk so a throw here
// leaves nothing partially written.

export function renderTemplate(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    // A replacer function keeps `$&`/`$'` in values (deny patterns) literal.
    out = out.replaceAll(`{{${key}}}`, () => value);
  }
  // Real placeholders are UPPER_SNAKE (`{{PACKAGES_BLOCK}}`). Templates also
  // carry literal `{{...}}` in documentation prose — those are not placeholders
  // and must not trip the guard.
  const leftover = out.match(/\{\{[A-Z][A-Z0-9_]*\}\}/);
  if (leftover) {
    throw new Error(`renderTemplate: unsubstituted placeholder ${leftover[0]}`);
  }
  return out;
}
