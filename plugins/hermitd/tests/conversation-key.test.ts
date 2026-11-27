import { test, expect } from 'bun:test';
import { baseChat, conversationKey, isKey, parseKey } from '../scripts/lib/conversation-key';

test('a key builds, checks and takes itself apart', () => {
  const threaded = conversationKey('telegram', '-100123', '45');
  expect(threaded).toBe('telegram:-100123~45');
  expect(isKey(threaded)).toBe(true);
  expect(parseKey(threaded)).toEqual({ source: 'telegram', chat: '-100123', thread: '45' });
  expect(baseChat(threaded)).toBe('telegram:-100123');
  const whole = conversationKey('imessage', 'iMessage;-;+15550100');
  expect(parseKey(whole)).toEqual({ source: 'imessage', chat: 'iMessage;-;+15550100', thread: undefined });
  expect(baseChat(whole)).toBe(whole);
});

test('the first tilde after the source starts the thread', () => {
  expect(parseKey('slack:C1~1712345678.123456~x')).toEqual({ source: 'slack', chat: 'C1', thread: '1712345678.123456~x' });
  expect(parseKey('custom:C1~')).toEqual({ source: 'custom', chat: 'C1', thread: '' });
});
