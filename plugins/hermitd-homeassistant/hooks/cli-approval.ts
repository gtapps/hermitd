import { basename, resolve } from 'node:path';
import { shellCommands } from './shell-words';
import { gateServiceCall, evaluateReferences, isWellFormedEntityId, PermissionDecision } from '../src/policy';
import { loadSnapshot } from '../src/snapshot-restore';
import { projectRoot } from '../src/config';

export async function decision(command: string, cwd: string, root: string): Promise<{ decision: 'ask' | 'deny'; reason: string } | null> {
  // Matched unqualified: the command reaches this hook unexpanded, so
  // `bun ${CLAUDE_PLUGIN_ROOT}/src/cli.ts` never carries the plugin directory
  // name. An unrelated `src/cli.ts` is filtered by the `ha` subcommand check below.
  if (!command.includes('ha-agent-lab') && !command.includes('src/cli.ts')) return null;
  let result: { decision: 'ask' | 'deny'; reason: string } | null = null;
  for (const words of shellCommands(command)) {
    if (words[0] === 'cd' && words.length === 2) { cwd = resolve(cwd, words[1]); continue; }
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
    if (basename(words[0] ?? '') === 'bun' && words[1] === 'run') words.splice(1, 1);
    const index = words.findIndex(word => basename(word) === 'ha-agent-lab' || word === 'src/cli.ts' || word.endsWith('/src/cli.ts'));
    if (index < 0 || (index !== 0 && !(index === 1 && ['bun', 'node', 'bash'].includes(basename(words[0])))) || words[index + 1] !== 'ha' || !['call-service', 'restore-states'].includes(words[index + 2])) continue;
    const argv = words.slice(index + 1);
    if (argv.includes('--help') || argv.includes('-h')) continue;
    const { parseArgs } = await import('../src/cli');
    const args = parseArgs(argv);
    if (args.sub === 'call-service') {
      const [domain, service, ...extra] = args.positionals[0].split('.');
      if (!domain || !service || extra.length) throw new Error('Invalid service');
      const data = JSON.parse(String(args.flags['--data'] ?? '{}'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid service data');
      const gate = gateServiceCall(root, domain, service, data);
      if (gate.decision === 'deny') return { decision: 'deny', reason: gate.reason };
      if (gate.decision === 'ask') result = { decision: 'ask', reason: gate.reason };
    } else {
      const snapshot = loadSnapshot(resolve(cwd, args.positionals[0]));
      const entities = Object.keys(snapshot.entities);
      if (!entities.length || entities.some(entity => !isWellFormedEntityId(entity))) throw new Error('Unresolvable snapshot targets');
      const policy = evaluateReferences(entities, ['scene.apply'], root);
      if (policy.decision === PermissionDecision.DENY) return { decision: 'deny', reason: 'Snapshot restore is blocked by Home Assistant policy.' };
      if (policy.decision === PermissionDecision.ASK) result = { decision: 'ask', reason: `Restore snapshot affecting sensitive entities: ${entities.join(', ')}` };
    }
  }
  return result;
}
if (import.meta.main) {
  try {
    const payload = JSON.parse(await Bun.stdin.text());
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid hook payload');
    if (payload.tool_name === 'Bash' && typeof payload.tool_input?.command === 'string') {
      const verdict = await decision(payload.tool_input.command, payload.cwd ?? process.cwd(), projectRoot());
      if (verdict) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: verdict.decision, permissionDecisionReason: verdict.reason } }));
    }
  } catch {
    console.error('Cannot verify Home Assistant CLI targets.');
    process.exit(2);
  }
}
