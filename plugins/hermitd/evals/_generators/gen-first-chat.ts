// Generate behaviour evals for injected first-chat text; these do not exercise the hook.
import fs from 'node:fs';
import path from 'node:path';
import { EVALS, PLUGIN, type Grader, indent, report, residentPrompt, residentScaffold, writeCase, yq } from './lib';

const OUT = path.join(EVALS, 'first-chat');
const FIRST_CHAT = fs.readFileSync(path.join(PLUGIN, 'prompts/first-chat.md'), 'utf8');
const NOW = '[Now: Sunday, 2026-11-15 14:30 UTC]';
const CONFIG = { timezone: 'UTC', language: null, agent_name: null, channels: {}, routines: [] };
const STUB = '#!/usr/bin/env bash\necho OK\n';
const injected = (message: string) => `${NOW}\n${FIRST_CHAT}\n${message}`;
const rubric = (name: string, criteria: string, focus = 'last_message'): Grader => ({ name, type: 'llm', focus, criteria, weight: 3 });

function firstChatCase(name: string, description: string, prompt: string, graders: Grader[], history?: string): void {
  const dir = path.join(OUT, name);
  const yaml = ['schema_version: "1.1"', `name: ${name}`, `description: ${yq(description)}`, 'tags: [first-chat]',
    'context:', '  scaffold_script: scaffold.sh', ...(history ? ['  history_file: history.jsonl'] : []),
    'execution:', '  max_turns: 16', '  timeout_seconds: 420', '  allowed_tools: [Skill, Read, Glob, Grep, Bash, Write]',
    '  env: {EVAL_HERMIT_RESIDENT: "1"}', '  append_system_prompt: |', indent(residentPrompt()),
    '  prompt: |', indent(prompt), 'graders:', ...graders.map(g => '  - ' + JSON.stringify(g))];
  writeCase(dir, yaml, residentScaffold(CONFIG, { '.hermit/bin/hermitd-run': STUB }) + 'chmod +x .hermit/bin/hermitd-run\n');
  if (history) fs.writeFileSync(path.join(dir, 'history.jsonl'), history);
}

firstChatCase('request-before-introduction', 'The requested result precedes the first-chat closing lines.',
  injected('What is 17 times 23?'), [rubric('request-first',
    'PASS when the response gives the correct result, 391, before introducing the agent. The closing lines briefly introduce the agent, check the supplied local time and invite ongoing work. Judge ordering and purpose, not exact wording.')]);

function history(): string {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const turns = [injected('Hello'), 'I am your agent. It is 14:30 for me, is that your time? What should I do for you? Tell me anytime how you like me to work.'];
  return turns.map((text, i) => {
    const uuid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    const role = i === 0 ? 'user' : 'assistant';
    return JSON.stringify({ type: role, uuid, parentUuid: i ? '00000000-0000-4000-8000-000000000001' : null,
      sessionId, timestamp: '2026-11-15T14:30:00.000Z', cwd: '/workspace', version: '2.1.325',
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }],
        model: 'claude-sonnet-5-5', id: 'msg_first_chat', type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
  }).join('\n') + '\n';
}

firstChatCase('second-turn-no-repeat', 'A resumed conversation does not repeat first-chat onboarding.',
  `${NOW}\nYes, that is my time. What is 8 times 9?`, [rubric('no-repeat',
    'PASS when the response answers 72 without repeating the introduction or asking whether the local time matches. The first-chat instructions and the completed introduction are in conversation history, not a new injection.')], history());

firstChatCase('supplied-language-after-reply', 'A non-English first request is answered before supplied-value language setup.',
  injected('Quanto é 17 vezes 23?'), [rubric('language-after-reply',
    'PASS when the agent first sends a Portuguese reply answering 391 with brief first-chat closing lines, then invokes the hermit-settings skill with language and a supplied Portuguese value (pt or equivalent). It must not ask the operator to choose a language or detect the system locale. Judge the sequence of reply then language invocation from the trace, not exact wording.', 'trace'),
  { name: 'supplied-language', type: 'tool_used', tool: 'Skill', input_match: String.raw`hermit-settings[\s\S]*language\s+(?:pt|Portugu)` }]);

report('first-chat');
