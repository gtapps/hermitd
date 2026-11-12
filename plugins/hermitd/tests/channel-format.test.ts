import { describe, expect, test } from 'bun:test';
import { capDiscordParts, convertText, formatFor, hintFor, splitForPlatform, splitTableRow, stripMarkdown } from '../scripts/lib/channel-format';

describe('Hermes channel formatting ports (2c7104fc04)', () => {
  test('selection is explicit except for built-in keys', () => {
    expect(formatFor({}, 'custom')).toBeNull();
    expect(formatFor({}, 'discord')).toBe('discord');
    expect(formatFor({}, 'telegram')).toBe('telegram');
    expect(formatFor({ channels: { discord: { format: 'passthrough' } } }, 'discord')).toBeNull();
    expect(formatFor({ channels: { custom: { format: 'slack' } } }, 'custom')).toBe('slack');
    expect(hintFor({}, 'custom')).toBeNull();
  });
  // tests/gateway/test_discord_format.py, TestDiscordFormatMessage.
  test('tables become bullet groups; repeated heading cells are dropped', () => {
    const text = 'Results:\n\n| Name | Score |\n|------|-------|\n| Alice | 95 |\n| Bob | 80 |\n\nDone.';
    expect(convertText(text, 'discord')).toBe('Results:\n\n**Alice**\n• Score: 95\n\n**Bob**\n• Score: 80\n\nDone.');
    expect(convertText('| A | B |\n|---|---|\n| same | same |', 'discord')).toBe('**same**');
    const literal = '  hello **world**\n```ts\n| a | b |\n|---|---|\n```\n';
    expect(convertText(literal, 'discord')).toBe(literal);
    expect(convertText('  no table\n', 'discord')).toBe('  no table\n');
  });
  // tests/agent/test_markdown_tables.py, split_table_row fixtures.
  test.each([
    ['| a | b | c |', ['a', 'b', 'c']],
    ['|配置|状态|', ['配置', '状态']],
    ['a | b | c', ['a', 'b', 'c']],
    ['| Feature | `| table |` |', ['Feature', '`| table |`']],
    ['| `a|b` | `c|d` |', ['`a|b`', '`c|d`']],
    [String.raw`| left\|right | next |`, [String.raw`left\|right`, 'next']],
    ['| don`t | it`s | 3 |', ['don`t', 'it`s', '3']],
    ['| pipe | `ls | grep x` |', ['pipe', '`ls | grep x`']],
    ['| `--out | path | `x` |', ['`--out', 'path', '`x`']],
    ['| `` | x | `` |', ['``', 'x', '``']],
    ['| 2 | 运行`ps aux | grep py`即可 |', ['2', '运行`ps aux | grep py`即可']],
  ] as [string, string[]][])('splits %s', (row, cells) => expect(splitTableRow(row)).toEqual(cells));
  // tests/gateway/test_sms.py, TestSmsFormatting, plus documented strip quirks.
  test('plain text stripping preserves targets and strip quirks', () => {
    expect(stripMarkdown('  hello  \n')).toBe('hello');
    expect(stripMarkdown('```python\nprint("*keep*")\n```')).toBe('print("keep")');
    expect(stripMarkdown("```python\nprint('hi')\n```")).toBe("print('hi')");
    expect(stripMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
    expect(convertText('**bold** and [link](https://example.com)', 'telegram')).toBe('bold and link\nhttps://example.com');
  });
  // tests/gateway/test_mattermost.py, TestMattermostFormatMessage.
  test('Mattermost reduces images only', () => {
    expect(convertText('![cat](https://img.example.com/cat.png)', 'mattermost')).toBe('https://img.example.com/cat.png');
    const text = '**bold** and *italic* and `code`';
    expect(convertText(text, 'mattermost')).toBe(text);
  });
  // tests/gateway/test_platform_base.py, truncate_message fixtures.
  test('splitting balances fences and numbers parts', () => {
    expect(splitForPlatform('Hello world', 100)).toEqual(['Hello world']);
    const chunks = splitForPlatform('```python\n' + 'print("hello")\n'.repeat(100) + '```', 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.length).toBeLessThanOrEqual(300);
      expect(chunk.endsWith(` (${i + 1}/${chunks.length})`)).toBe(true);
      expect(chunk.match(/```/g)?.length).toBe(2);
    }
    expect(capDiscordParts(Array(10).fill('part'), 'Rest is on the task.')).toEqual([...Array(7).fill('part'), '\n\nRest is on the task.']);
  });
  test('dialect conversions protect code', () => {
    expect(convertText('**hello** `**literal**`', 'slack')).toBe('*hello* `**literal**`');
    expect(convertText('**hello** `**literal**`', 'google_chat')).toBe('*hello* `**literal**`');
    expect(convertText('**hello** `**literal**`', 'whatsapp')).toBe('*hello* `**literal**`');
  });
});
