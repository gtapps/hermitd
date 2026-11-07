// Decision reply routing. Script state transitions are covered by task-answer.test.ts;
// these cases check the model invokes the answer boundary and explains its verdict.
import path from 'node:path';
import { CHAT, USER, EVALS, configJson, withInstall, decisionFixture, graderYaml, heredocs, indent, report, residentScaffold, writeCase, yq } from './lib';

const MEMBER = '100000000000000002';
const cases = [
  ['proposal-yes-single-open', 'YES', 'consent', 'admin', USER, 'match'],
  ['proposal-accept-single-open-pt', 'sim', 'consent', 'admin', USER, 'match'],
  ['proposal-defer-single-open-pt', 'mais tarde', 'consent', 'admin', USER, 'none'],
  ['proposal-accept-number', 'yes, archive the reports', 'consent', 'admin', USER, 'match'],
  ['proposal-later-two-open', 'later', 'consent', 'admin', USER, 'ambiguous'],
  ['proposal-no-two-open', 'no', 'consent', 'admin', USER, 'ambiguous'],
  ['micro-label-answer', 'weekly', 'input', 'requester', USER, 'match'],
  ['micro-member-answers-live-ask', 'weekly', 'input', 'requester', MEMBER, 'match'],
  ['micro-member-yes-admin-question', 'yes', 'consent', 'admin', MEMBER, 'refused'],
  ['micro-yes-beats-task-confirm', 'yes', 'input', 'chat', USER, 'match'],
  ['bare-yes-no-pending-micro', 'yes', 'result', 'requester', USER, 'match'],
] as const;
for (const [name, reply, purpose, authority, sender, status] of cases) {
  const multi = status === 'ambiguous';
  const decision = JSON.stringify({purpose, authority, generation: 1, ...(purpose === 'input' && authority === 'requester' ? {options:['daily','weekly']} : {})});
  const fixture = decisionFixture('T-20261001-090000', purpose === 'input' ? (reply === 'yes' ? 'Should the reports run weekly?' : 'How often should reports run: daily or weekly?') : purpose === 'result' ? 'Draft the release note' : 'Archive old helper reports', {
    kind: purpose === 'consent' ? 'proposal' : null, requester: purpose === 'consent' ? 'agent' : `discord:${sender}`,
    decision, waiting_on: authority, ...(purpose === 'result' ? {result: 'The release note is ready', result_at: '2026-10-01T09:00:00.000Z', result_rev: 1} : {}) });
  const receipt = {status, ...(status === 'refused' ? {reason:'not_decider'} : status === 'ambiguous' ? {reason:'multiple_pending'} : status === 'none' ? {reason:'no_match'} : {id:'T-20261001-090000',purpose,reply:purpose === 'input' && reply !== 'yes' ? 'weekly' : 'yes'})};
  const fixtures = Object.fromEntries([fixture, ...(multi ? [decisionFixture('T-20261001-090001','Send a weekly digest')] : [])]);
  const runner = '#!/usr/bin/env bash\n# Answer boundary stand-in; no other script is mocked.\nif [ "$1" = task ] && [ "$2" = answer ]; then\ncat <<\'ANSWER\'\n'+JSON.stringify(receipt)+'\nANSWER\nelse\n  echo \'{"status":"ok"}\'\nfi\n';
  const config = {operator_profile:'technical',channels:{discord:{allowed_users:[USER,MEMBER],default_chat_id:CHAT}}};
  const scaffold = residentScaffold(config,fixtures)
    + heredocs({'.hermit/bin/hermitd-run':runner}).join('\n')+'\nchmod +x .hermit/bin/hermitd-run\n';
  const message = '<channel source="plugin:discord:discord" chat_id="'+CHAT+'" message_id="500000000000000036" user="sam" user_id="'+sender+'" ts="2026-10-01T09:26:00.000Z">\n'+reply+'\n</channel>';
  const context = withInstall({ '.hermit/config.json': configJson(config), ...fixtures }, ({ run }) =>
    run('user-prompt-pipeline.ts', [], { stdin: JSON.stringify({ prompt: message }), now: '2026-10-01T09:26:00.000Z' })
      .split('\n').filter(line => !line.startsWith('[Now:')).join('\n'));
  const prompt = '<system-reminder>\nUserPromptSubmit hook additional context:\n' + context + '\n</system-reminder>\n' + message;
  const expected = status === 'refused' ? 'Only the admin can decide; no approval.' : multi ? 'Ask which pending task; no transition.' : status === 'none' ? 'Leave the decision waiting.' : 'Acknowledge the answered task without exposing internal ids.';
  // With two or more pending, the responder asks which one first and records nothing, so the answer call is optional.
  const graders = [
    ...(multi ? [] : [{name:'answer-boundary',type:'tool_used',tool:'Bash',input_match:String.raw`task(?:\.ts)? answer[\s\S]*--chat[\s\S]*--user[\s\S]*--reply`,weight:3}]),
    {name:'reply',type:'tool_used',tool:'mcp__plugin_discord_discord__reply'},
    {name:'decision-verdict',type:'llm',focus:'mock_calls',criteria:'PASS if the channel reply follows this verdict: '+expected+' FAIL otherwise.',weight:2}];
  writeCase(path.join(EVALS,'channel-routing',name),['schema_version: "1.1"',`name: ${name}`,`description: ${yq('Task decision reply: '+purpose+'/'+authority+' as '+(sender===USER?'admin':'member'))}`,'tags: [channel-routing, decision-replies]',`expected_outcome: ${yq(expected)}`,'context:','  scaffold_script: scaffold.sh','execution:','  max_turns: 10','  timeout_seconds: 240','  allowed_tools: [Skill, Read, Glob, Grep, Bash]','  env: {EVAL_HERMIT_RESIDENT: "1"}','  prompt: |',indent(prompt.replace(/[ \t]+$/gm, '')),'graders:',...graders.map(graderYaml)],scaffold);
}
report('channel-routing');
