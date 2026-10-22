// Cross-plugin guard: every domain hatch runs the shared protocol, and none of
// them carries a second copy of it.
//
// Lives at the repo root rather than in any plugin's suite because it spans
// plugins — a core-owned copy would never run on a domain-only PR under the
// per-plugin path filters, and a per-plugin copy would have to be remembered
// five times.
//
// Discovery is derived from the filesystem. Earlier hardcoded lists went stale
// when a fifth plugin shipped, so a sixth must be covered the day it lands
// without anyone updating a list.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { isModelInvocationDisabled } from '../../plugins/hermitd/tests/helpers/skill-frontmatter';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins');

interface DomainHatch {
  slug: string;
  file: string;
  text: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A plugin is in scope when it has a hatch, declares a core dependency, and
// that hatch actually does target routing. The first two conditions alone would
// pull in hermitd-scribe, which declares the dependency but carries none of the
// target-writing protocol (it only reads the target through preflight, never
// resolves or stamps it). Its read-only use is checked separately below.
function pluginSlugs(): string[] {
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'hermitd')
    .map((d) => d.name);
}

function discover(): DomainHatch[] {
  return pluginSlugs()
    .map((slug) => ({
      slug,
      file: path.join(PLUGINS_DIR, slug, 'skills', 'hatch', 'SKILL.md'),
      meta: path.join(PLUGINS_DIR, slug, '.claude-plugin', 'hermit-meta.json'),
    }))
    .filter((p) => fs.existsSync(p.file) && fs.existsSync(p.meta))
    .map((p) => {
      const meta = (() => { try { return JSON.parse(fs.readFileSync(p.meta, 'utf-8')); } catch { return null; } })();
      return { slug: p.slug, file: p.file, meta, text: fs.readFileSync(p.file, 'utf-8') };
    })
    .filter((p) => Boolean(p.meta?.required_core_version) && p.slug !== 'hermitd-scribe' && p.text.includes('domain-hatch'))
    .map(({ slug, file, text }) => ({ slug, file, text }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

const HATCHES = discover();

describe('discovery', () => {
  // Set equality by name, not a count floor: a count stays green when a sixth
  // plugin ships and a hatch is later rewritten to stop invoking the protocol
  // — the exact drift class this file exists to prevent. hermitd-scribe is the
  // one named exemption (it declares the floor but only reads the target,
  // never resolves or stamps it).
  test('finds the domain hatches that run the shared protocol', () => {
    const expected = pluginSlugs()
      .filter(
        (slug) =>
          slug !== 'hermitd-scribe' &&
          fs.existsSync(path.join(PLUGINS_DIR, slug, 'skills', 'hatch', 'SKILL.md')) &&
          fs.existsSync(path.join(PLUGINS_DIR, slug, '.claude-plugin', 'hermit-meta.json')),
      )
      .sort();
    expect(HATCHES.map((h) => h.slug)).toEqual(expected);
  });

  test('scribe reads the shared target without resolving or stamping it', () => {
    const text = fs.readFileSync(path.join(PLUGINS_DIR, 'hermitd-scribe/skills/hatch/SKILL.md'), 'utf8');
    expect(text).toContain('domain-hatch preflight hermitd-scribe');
    expect(text).toContain('Map `target` (or `target_default` when absent)');
    expect(text).not.toContain('hatch-options.json');
    expect(text).not.toContain('domain-hatch ensure-target');
    expect(text).toContain('If it prints `error`');
  });

  test('never includes core, which is not a consumer of its own protocol', () => {
    expect(HATCHES.map((h) => h.slug)).not.toContain('hermitd');
  });
});

for (const { slug, text } of HATCHES) {
  describe(`${slug}:hatch`, () => {
    test('reaches core through bin/hermitd-run, not a relative path', () => {
      expect(text).toContain('.hermit/bin/hermitd-run domain-hatch');
      // A domain plugin's ${CLAUDE_PLUGIN_ROOT} is <cache>/<mp>/<plugin>/<version>/,
      // so no static ../hermitd/... path resolves from one.
      expect(text).not.toContain('../hermitd/scripts');
    });

    // The live bug this whole change exists for: four hatches checked a floor
    // in prose that was 1 to 14 minor versions below what their own manifest
    // declared, so they proceeded against a core too old for them.
    // Scoped to the CORE floor: a hatch may legitimately state a version
    // requirement for something else (forge checks PHP >= 8.5.0). What must
    // never come back is a core-hermit floor written into skill prose, where
    // it drifts from the manifest that actually declares it.
    test('states no hardcoded core version floor', () => {
      const lines = text.split('\n').filter((l) =>
        /(?:base hermit|core hermit|hermitd|_hermit_versions)/i.test(l),
      );
      for (const line of lines) {
        expect(line).not.toMatch(/(?:requires|earlier than|less than|below)\s+`?≥?>?=?\s*\d+\.\d+\.\d+/i);
      }
    });

    // `claude plugin list` spans every project on the machine, so a hatch that
    // reads it to decide whether a plugin is present here skips wrongly.
    test('neither detects nor installs other plugins', () => {
      expect(text).not.toContain('claude plugin list');
      expect(text).not.toContain('claude plugin install');
    });

    test('does not restate the install-scope precedence rules', () => {
      expect(text).not.toMatch(/precedence\s+`?local`?\s*>/);
    });

    test('does not restate the hatch-options stamp schema', () => {
      expect(text).not.toMatch(/"stamped_by":\s*"/);
      expect(text).not.toMatch(/"core_install_scope":\s*"/);
    });

    // Top-level `Stop.` sat outside the version-check branch in three hatches;
    // read literally it ends the skill unconditionally after step 1.
    test('has no bare top-level Stop. line', () => {
      expect(text.split('\n').some((l) => l.trim() === 'Stop.')).toBe(false);
    });

    // The slug-parameterized half of the contract. These lived as per-plugin
    // clones in three plugins' tests/hatch-skill.test.ts (and were unasserted
    // for dev and feed) before being folded in here.
    test('runs preflight keyed to its own plugin id', () => {
      expect(text).toContain(`domain-hatch preflight ${slug}`);
    });

    test('stamps its own version into _hermit_versions, sourced from the preflight verdict', () => {
      expect(text).toContain(`_hermit_versions["${slug}"]`);
      expect(
        new RegExp(`_hermit_versions\\["${escapeRe(slug)}"\\][\\s\\S]{0,60}self_version`).test(text),
      ).toBe(true);
    });

    test('branches on every preflight action value', () => {
      for (const action of ['upgrade_core_package', 'upgrade_core_applied', '`verify`', '`full`']) {
        expect(text).toContain(action);
      }
    });

    if (text.includes('## Native approval rules')) {
      test('records the operator choice via ensure-target', () => {
        expect(text).toContain(`domain-hatch ensure-target ${slug} --target`);
      });

      test('consumes the preflight target fields for native permissions', () => {
        for (const field of ['target', 'target_default', 'needs_target_question']) {
          expect(text).toContain('`' + field + '`');
        }
      });

      test('Visibility prompt still offers .local vs committed', () => {
        expect(/Visibility[\s\S]{0,240}`\.local` files[\s\S]{0,120}Committed files/.test(text)).toBe(true);
      });
    }

    test('does not read hatch-options.json directly', () => {
      expect(text).not.toContain('hatch-options.json');
    });


  });
}

// The three places a plugin declares its core floor: `required_core_version`
// and `requires["hermitd"]` in hermit-meta.json, and the resolver's
// `dependencies` entry in plugin.json. Relocated from core's
// hooks.contract.test.ts (which never fires on a domain-manifest-only PR under
// the per-plugin path filters); the /bump-core-req skill and the
// release-auditor's check 7 keep the copies aligned at write/release time.
// Scope is wider than HATCHES — scribe declares the dependency without running
// the hatch protocol.
describe('core-floor version triple', () => {
  const declaring = pluginSlugs()
    .filter((slug) =>
      fs.existsSync(path.join(PLUGINS_DIR, slug, '.claude-plugin', 'hermit-meta.json')),
    )
    .sort();

  test('every domain plugin declares the floor', () => {
    // Set equality by name: a plugin dir that ships a plugin.json without a
    // hermit-meta.json floor must fail here, not slip under a count.
    const expected = pluginSlugs()
      .filter((slug) =>
        fs.existsSync(path.join(PLUGINS_DIR, slug, '.claude-plugin', 'plugin.json')),
      )
      .sort();
    expect(declaring).toEqual(expected);
  });

  for (const slug of declaring) {
    test(`${slug}: required_core_version, requires, and dependencies agree`, () => {
      const dir = path.join(PLUGINS_DIR, slug, '.claude-plugin');
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'hermit-meta.json'), 'utf-8'));
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf-8'));

      const floor = meta.required_core_version as string;
      expect(floor).toMatch(/^>=\d+\.\d+\.\d+$/);
      expect(meta.requires?.['hermitd']).toBe(floor);

      const dep = (pj.dependencies ?? []).find(
        (d: { name: string; version: string }) => d.name === 'hermitd',
      );
      // The dep carries whatever range operator its plugin uses (`^` today;
      // /bump-core-req preserves `^`, `~`, `>=`, or exact) — the invariant is
      // that the X.Y.Z base agrees with the hermit-meta floor.
      expect(dep?.version).toBeDefined();
      expect(dep.version.replace(/^[<>=^~!]+/, '')).toBe(floor.replace(/^>=/, ''));
    });
  }
});

describe('core side of the contract', () => {
  const coreScripts = path.join(PLUGINS_DIR, 'hermitd', 'scripts');

  test('the script the hatches invoke exists', () => {
    expect(fs.existsSync(path.join(coreScripts, 'domain-hatch.ts'))).toBe(true);
  });

  test('each verb is granted separately, never as one wildcard', () => {
    const applySettings = fs.readFileSync(path.join(coreScripts, 'apply-settings.ts'), 'utf-8');
    for (const verb of ['preflight', 'ensure-target']) {
      expect(applySettings).toContain(`bin/hermitd-run domain-hatch ${verb} *`);
    }
    // A bare `domain-hatch *` would hand every caller the mutating verb.
    expect(applySettings).not.toContain('bin/hermitd-run domain-hatch *');
  });

  // apply-settings.ts is the single owner of the literal entries; hatch carries
  // only the rationale for why they exist. Asserting the entries twice would
  // reintroduce the duplication the permissions single-owner change removed.
  test('hatch SKILL.md explains the domain-hatch route without re-listing it', () => {
    const hatch = fs.readFileSync(path.join(PLUGINS_DIR, 'hermitd', 'skills', 'hatch', 'SKILL.md'), 'utf-8');
    expect(hatch).toContain('hermitd-run domain-hatch');
    expect(hatch).not.toContain('"Bash(.hermit/bin/hermitd-run domain-hatch');
  });

  test('core hatch keys "already initialized" on config.json', () => {
    const hatch = fs.readFileSync(path.join(PLUGINS_DIR, 'hermitd', 'skills', 'hatch', 'SKILL.md'), 'utf-8');
    expect(hatch).toContain('.hermit/config.json');
    expect(hatch).toContain('already initialized');
  });


});

// Only the cross-plugin half lives here. The core-side inventory (which of
// core's own skills carry the flag) is asserted exactly, not as a subset, by
// plugins/hermitd/tests/contracts.test.ts § model-invocable
// inventory — and this workflow's path filters do not even watch core's
// non-hatch skill dirs, so a copy here would never fire on an edit to them.
describe('instruction delivery', () => {
  for (const slug of pluginSlugs()) {
    test(`${slug}: hatch writes no instruction block`, () => {
      const text = fs.readFileSync(path.join(PLUGINS_DIR, slug, 'skills/hatch/SKILL.md'), 'utf8');
      expect(text).not.toMatch(/(?:append|inject|replace|update|write)[^\n]{0,120}CLAUDE(?:\.local)?\.md/i);
      expect(text).not.toMatch(/<!-- \/?[^:\s]*hermit[^:\s]*:/);
    });
  }
});

describe('operator-only wizard contract', () => {
  test('every hatch skill disables model invocation', () => {
    const hatchSkills = [...pluginSlugs(), 'hermitd']
      .map((slug) => path.join(PLUGINS_DIR, slug, 'skills', 'hatch', 'SKILL.md'))
      .filter((file) => fs.existsSync(file));

    expect(hatchSkills.length).toBeGreaterThan(0);
    for (const file of hatchSkills) {
      expect(isModelInvocationDisabled(fs.readFileSync(file, 'utf-8'))).toBe(true);
    }
  });
});
