/*
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// Hermes Agent ports below preserve the rules at commit 2c7104fc04.
export const CHANNEL_FORMATS = ['discord', 'telegram', 'signal', 'matrix', 'mattermost', 'sms', 'bluebubbles', 'line', 'irc', 'email', 'ntfy', 'slack', 'google_chat', 'whatsapp', 'passthrough'] as const;
export type ChannelFormat = typeof CHANNEL_FORMATS[number];
type Config = { channels?: Record<string, { format?: unknown; enabled?: boolean }> };
export function formatFor(config: Config, channelKey: string): ChannelFormat | null {
  const value = config.channels?.[channelKey]?.format ?? (['discord', 'telegram'].includes(channelKey) ? channelKey : null);
  return value !== 'passthrough' && CHANNEL_FORMATS.includes(value as ChannelFormat) ? value as ChannelFormat : null;
}

// gateway/platforms/helpers.py, _STRIP_RULES, _keep_link_target, strip_markdown (2c7104fc04).
function keepLinkTarget(_match: string, label: string, target: string): string {
  const cleanLabel = label.trim();
  target = target.trim();
  return /^https?:\/\//i.test(target) ? (cleanLabel === target ? target : `${cleanLabel}\n${target}`) : label;
}
const STRIP_RULES: [RegExp, string][] = [
  [/\*\*(.+?)\*\*/gs, '$1'], [/\*(.+?)\*/gs, '$1'],
  [/\b__(?![\s_])(.+?)(?<![\s_])__\b/gs, '$1'], [/\b_(?![\s_])(.+?)(?<![\s_])_\b/gs, '$1'],
  [/```[a-zA-Z0-9_+-]*\n?/g, ''], [/`(.+?)`/g, '$1'], [/^#{1,6}\s+/gm, ''],
];
export function stripMarkdown(text: string, keepLinkTargets = false): string {
  for (const [pattern, replacement] of STRIP_RULES) text = text.replace(pattern, replacement);
  text = keepLinkTargets ? text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, keepLinkTarget) : text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// agent/markdown_tables.py, _fills_cell (2c7104fc04).
function fillsCell(row: string, start: number, end: number): boolean {
  let left = start; let right = end;
  while (left > 0 && /\s/.test(row[left - 1])) left--;
  while (right < row.length && /\s/.test(row[right])) right++;
  return (left === 0 || (row[left - 1] === '|' && left < start)) && (right === row.length || (row[right] === '|' && right > end));
}
// agent/markdown_tables.py, _is_apostrophe (2c7104fc04).
function isApostrophe(row: string, start: number, end: number): boolean {
  return end - start === 1 && start > 0 && /[A-Za-z]/.test(row[start - 1]) && /^(?:[stdm]|ll|re|ve)(?![A-Za-z])/i.test(row.slice(end));
}
// agent/markdown_tables.py, _is_space (2c7104fc04).
function isSpace(row: string, pos: number): boolean { return pos < 0 || pos >= row.length || /\s/.test(row[pos]); }
// agent/markdown_tables.py, _not_a_code_span (2c7104fc04).
function notACodeSpan(row: string, opener: number, openerEnd: number, closingEnd: number): boolean {
  const closer = closingEnd - (openerEnd - opener);
  return isApostrophe(row, opener, openerEnd) || (isSpace(row, openerEnd) && !isSpace(row, opener - 1) && row[opener - 1] !== '|') || (isSpace(row, closer - 1) && !isSpace(row, closingEnd)) || (fillsCell(row, opener, openerEnd) && fillsCell(row, closer, closingEnd));
}
// agent/markdown_tables.py, split_table_row (2c7104fc04).
export function splitTableRow(row: string): string[] {
  const nextRun = new Map<number, number>(); const matchingEnds = new Map<number, number>();
  let scan = row.length - 1;
  while (scan >= 0) {
    if (row[scan] !== '`') { scan--; continue; }
    const end = scan + 1;
    while (scan >= 0 && row[scan] === '`') scan--;
    const start = scan + 1; const width = end - start;
    if (width > 1 && nextRun.has(width - 1)) matchingEnds.set(start + 1, nextRun.get(width - 1)!);
    if (nextRun.has(width)) matchingEnds.set(start, nextRun.get(width)!);
    nextRun.set(width, end);
  }
  const cellEdges = [...row.matchAll(/ \| /g)].map(m => m.index + 1);
  const separators: number[] = [];
  let i = 0;
  while (i < row.length) {
    if (row[i] === '\\') {
      const start = i;
      while (i < row.length && row[i] === '\\') i++;
      if ((i - start) % 2 && i < row.length) i++;
      continue;
    }
    if (row[i] === '`') {
      let end = i + 1;
      while (end < row.length && row[end] === '`') end++;
      const closing = matchingEnds.get(i);
      if (closing !== undefined) {
        const edge = cellEdges.find(e => e >= end);
        if (edge === undefined || edge >= closing - (end - i) || !notACodeSpan(row, i, end, closing)) { i = closing; continue; }
      }
      i = end; continue;
    }
    if (row[i] === '|') separators.push(i);
    i++;
  }
  let start = 0; let end = row.length;
  if (separators.length && !row.slice(0, separators[0]).trim()) start = separators[0] + 1;
  if (separators.length && !row.slice(separators.at(-1)! + 1).trim()) end = separators.at(-1)!;
  if (start > end) return [''];
  const cells: string[] = []; let cellStart = start;
  for (const separator of separators) if (start <= separator && separator < end) { cells.push(row.slice(cellStart, separator).trim()); cellStart = separator + 1; }
  cells.push(row.slice(cellStart, end).trim());
  return cells;
}
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/;
// gateway/platforms/helpers.py, is_table_row (2c7104fc04).
function isTableRow(line: string): boolean { return line.trim().includes('|'); }
// gateway/platforms/helpers.py, _render_table_block (2c7104fc04).
function renderTableBlock(block: string[]): string {
  const headers = block.length >= 3 ? splitTableRow(block[0]) : [];
  if (headers.length < 2) return block.join('\n');
  const hasLabel = splitTableRow(block[2]).length === headers.length + 1;
  return block.slice(2).map((row, index) => {
    const cells = splitTableRow(row);
    const heading = (hasLabel ? cells[0] : cells.find(Boolean)) || `Row ${index + 1}`;
    const data = [...(hasLabel ? cells.slice(1) : cells), ...headers.map(() => '')].slice(0, headers.length);
    return [`**${heading}**`, ...headers.flatMap((header, i) => hasLabel || data[i] !== heading ? [`• ${header}: ${data[i]}`] : [])].join('\n');
  }).join('\n\n');
}
// gateway/platforms/helpers.py, convert_table_to_bullets (2c7104fc04).
export function convertTableToBullets(text: string): string {
  if (!text.includes('|') || !text.includes('-')) return text;
  const lines = text.split('\n'); const out: string[] = []; let inFence = false; let i = 0;
  while (i < lines.length) {
    const line = lines[i]; const fence = line.trimStart().startsWith('```');
    if (fence) inFence = !inFence;
    if (!(inFence || fence) && line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) j++;
      out.push(renderTableBlock(lines.slice(i, j))); i = j;
    } else { out.push(line); i++; }
  }
  return out.join('\n');
}
// gateway/platforms/helpers.py, fence_state_after (2c7104fc04).
function fenceStateAfter(text: string, inCode = false, lang = ''): [boolean, string] {
  for (const line of text.split('\n')) if (line.trim().startsWith('```')) {
    const tag = line.trim().slice(3).trim().split(/\s+/)[0];
    [inCode, lang] = inCode ? [false, ''] : [true, tag || ''];
  }
  return [inCode, lang];
}
// gateway/platforms/base.py, truncate_message (2c7104fc04). Python len/slicing count codepoints.
export function splitForPlatform(content: string, maxLen = 4096): string[] {
  const len = (s: string) => [...s].length;
  const slice = (s: string, start: number, end?: number) => [...s].slice(start, end).join('');
  if (len(content) <= maxLen) return [content];
  const chunks: string[] = []; let remaining = content; let carryLang: string | null = null;
  while (remaining) {
    const prefix = carryLang !== null ? `\x60\x60\x60${carryLang}\n` : '';
    let headroom = maxLen - 12 - len(prefix) - 4;
    if (headroom < 1) headroom = Math.max(1, Math.floor(maxLen / 2));
    if (len(prefix) + len(remaining) <= maxLen - 12) {
      let finalChunk = prefix + remaining;
      if (carryLang !== null && fenceStateAfter(remaining, true, carryLang)[0]) finalChunk += '\n```';
      chunks.push(finalChunk); break;
    }
    const region = slice(remaining, 0, headroom);
    let splitAt = len(region.slice(0, region.lastIndexOf('\n')));
    if (!region.includes('\n')) splitAt = -1;
    if (splitAt < Math.floor(headroom / 2)) splitAt = region.includes(' ') ? len(region.slice(0, region.lastIndexOf(' '))) : -1;
    if (splitAt < 1) splitAt = Math.max(1, headroom);
    const candidate = slice(remaining, 0, splitAt);
    if (((candidate.match(/`/g)?.length || 0) - (candidate.match(/\\`/g)?.length || 0)) % 2 === 1) {
      let last = candidate.lastIndexOf('`');
      while (last > 0 && candidate[last - 1] === '\\') last = candidate.lastIndexOf('`', last - 1);
      if (last > 0) {
        const safe = Math.max(candidate.lastIndexOf(' ', last - 1), candidate.lastIndexOf('\n', last - 1));
        if (safe >= 0 && len(candidate.slice(0, safe)) > Math.floor(headroom / 4)) splitAt = len(candidate.slice(0, safe));
      }
    }
    const body = slice(remaining, 0, splitAt); remaining = slice(remaining, splitAt).trimStart();
    const [inCode, lang] = fenceStateAfter(body, carryLang !== null, carryLang || '');
    carryLang = inCode ? lang : null;
    chunks.push(prefix + body + (inCode ? '\n```' : ''));
  }
  return chunks.length > 1 ? chunks.map((chunk, i) => `${chunk} (${i + 1}/${chunks.length})`) : chunks;
}
// plugins/platforms/discord/adapter.py, _cap_split_chunks, MAX_SPLIT_MESSAGES (2c7104fc04).
export function capDiscordParts(parts: string[], notice: string): string[] {
  return parts.length <= 8 ? parts : [...parts.slice(0, 7), `\n\n${notice}`];
}
// plugins/platforms/mattermost/adapter.py, format_message (2c7104fc04).
function imageToUrl(text: string): string { return text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$2'); }

// plugins/platforms/slack/adapter.py, _disp_width (2c7104fc04).
// East Asian W/F ranges generated from Python's unicodedata, as used by Hermes.
function displayWidth(text: string): number {
  return [...text].reduce((width, char) => {
    const cp = char.codePointAt(0)!;
    return width + (WIDE_RANGES.some(([lo, hi]) => lo <= cp && cp <= hi) ? 2 : 1);
  }, 0);
}
// plugins/platforms/slack/adapter.py, _pad (2c7104fc04).
function pad(cell: string, width: number): string { return cell + ' '.repeat(Math.max(width - displayWidth(cell), 0)); }
// plugins/platforms/slack/adapter.py, _split_table_row (2c7104fc04).
function slackSplitRow(line: string): string[] { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()); }
// plugins/platforms/slack/adapter.py, _align_table (2c7104fc04).
function alignTable(rows: string[]): string[] {
  if (rows.length < 2) return rows;
  let parsed = rows.map(slackSplitRow);
  const cols = Math.max(...parsed.map(row => row.length));
  parsed = parsed.map(row => [...row, ...Array<string>(cols - row.length).fill('')]);
  parsed[1] = Array<string>(cols).fill('---');
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...parsed.map(row => displayWidth(row[c]))));
  return parsed.map((row, i) => '| ' + row.map((cell, c) => i === 1 ? '-'.repeat(widths[c]) : pad(cell, widths[c])).join(' | ') + ' |');
}
// plugins/platforms/slack/adapter.py, _wrap_markdown_tables (2c7104fc04).
function wrapMarkdownTables(text: string): string {
  if (!text || !text.includes('|') || !text.includes('-')) return text;
  const lines = text.split('\n'); const out: string[] = []; let inFence = false; let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    else if (!inFence && line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) j++;
      out.push('```', ...alignTable(lines.slice(i, j)), '```'); i = j; continue;
    }
    out.push(line); i++;
  }
  return out.join('\n');
}
// plugins/platforms/slack/adapter.py, format_message (2c7104fc04).
function slackFormat(content: string): string {
  if (!content) return content;
  const saved: string[] = [];
  const ph = (value: string) => { const key = `\x00SL${saved.length}\x00`; saved.push(value); return key; };
  let text = wrapMarkdownTables(content).replace(/<!(?:everyone|channel|here)(?:\|[^>\n]*)?>/gi, m => m.replace('<', '&lt;'));
  text = text.replace(/(```(?:[^\n]*\n)?[\s\S]*?```)/g, (block: string, _group: string, offset: number, source: string) => ph(offset === 0 || source[offset - 1] === '\n' ? block.replace(/^```[^\s`]+[ \t]*(\r?\n)/, '```$1') : block));
  text = text.replace(/(`[^`]+`)/g, m => ph(m));
  text = text.replace(/(?<!!)\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_m, label: string, url: string) => {
    url = url.trim(); if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1).trim();
    return ph(`<${url}|${label}>`);
  });
  text = text.replace(/(<(?:[@#!]|(?:https?|mailto|tel):)[^>\n]+>)/g, m => ph(m));
  text = text.replace(/^(>+\s)/gm, m => ph(m));
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>' };
  text = text.replace(/&(amp|lt|gt);/g, (_m, entity: string) => entities[entity]).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, inner: string) => ph(`*${inner.trim().replace(/\*\*(.+?)\*\*/g, '$1')}*`));
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_m, inner: string) => ph(`*_${inner}_*`));
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner: string) => ph(`*${inner}${inner && !/[\p{L}\p{N}_]$/u.test(inner) ? '\u200b' : ''}*`));
  text = text.replace(/(?<!\*)\*(\S(?:[^*\n]*?\S)?)\*(?!\*)/g, (_m, inner: string) => ph(`_${inner}_`));
  text = text.replace(/~~(.+?)~~/g, (_m, inner: string) => ph(`~${inner}~`));
  for (let i = saved.length - 1; i >= 0; i--) text = text.replaceAll(`\x00SL${i}\x00`, saved[i]);
  return text;
}
// plugins/platforms/google_chat/cards.py, format_message (2c7104fc04).
function googleChatFormat(content: string): string {
  if (!content) return content;
  const saved: string[] = [];
  const ph = (value: string) => { const key = `\x00GC${saved.length}\x00`; saved.push(value); return key; };
  let text = content.replace(/(```(?:[^\n]*\n)?[\s\S]*?```)/g, m => ph(m)).replace(/(`[^`]+`)/g, m => ph(m));
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, inner: string) => ph(`*${inner.trim()}*`));
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_m, inner: string) => ph(`*_${inner}_*`));
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner: string) => ph(`*${inner}*`));
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => ph(`<${url}|${label}>`));
  text = text.replace(/[\u200b-\u200f\u2060\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu, '').replace(/  +/g, ' ');
  saved.forEach((value, i) => { text = text.replaceAll(`\x00GC${i}\x00`, value); });
  return text;
}
// gateway/platforms/whatsapp_common.py, _sanitize_outbound_text (2c7104fc04).
function sanitizeWhatsapp(content: string): string {
  return content.replace(/[\u200b\u2060\u2063\ufeff]/g, '').replace(/[\u00a0\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, ' ');
}
// gateway/platforms/whatsapp_common.py, _stash (2c7104fc04).
function stash(pattern: RegExp, text: string, tag: string): [string, string[]] {
  const saved: string[] = [];
  return [text.replace(pattern, m => { saved.push(m); return `\x00${tag}${saved.length - 1}\x00`; }), saved];
}
// gateway/platforms/whatsapp_common.py, _header_to_bold (2c7104fc04).
function headerToBold(_match: string, inner: string): string {
  inner = inner.trim();
  while (inner.length > 1 && inner.startsWith('*') && inner.endsWith('*')) inner = inner.slice(1, -1).trim();
  return `*${inner}*`;
}
// gateway/platforms/whatsapp_common.py, format_message (2c7104fc04).
function whatsappFormat(content: string): string {
  if (!content) return content;
  const [fenced, fences] = stash(/```[\s\S]*?```/g, sanitizeWhatsapp(content), 'FENCE');
  let [text, codes] = stash(/`[^`\n]+`/g, fenced, 'CODE');
  text = text.replace(/(?<!\*)\*(?!\s|\*)([^*\n]*?\S[^*\n]*?)\*(?!\*)/g, '_$1_')
    .replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '*$1*').replace(/~~(.+?)~~/g, '~$1~')
    .replace(/^#{1,6}\s+(.+)$/gm, headerToBold).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  for (const [tag, saved] of [['FENCE', fences], ['CODE', codes]] as const) saved.forEach((value, i) => { text = text.replaceAll(`\x00${tag}${i}\x00`, value); });
  return text;
}
export function convertText(text: string, spec: ChannelFormat | null): string {
  switch (spec) {
    case 'discord': case 'signal': return convertTableToBullets(text);
    case 'matrix': return imageToUrl(convertTableToBullets(text));
    case 'mattermost': return imageToUrl(text);
    case 'telegram': case 'sms': case 'bluebubbles': case 'line': case 'irc': case 'email': case 'ntfy': return stripMarkdown(convertTableToBullets(text), true);
    case 'slack': return slackFormat(text);
    case 'google_chat': return googleChatFormat(text);
    case 'whatsapp': return whatsappFormat(text);
    default: return text;
  }
}
// Hermes platform hints, adapter_hint.py / adapter.py / signal/register.py (2c7104fc04).
export function hintFor(config: Config, channelKey: string): string | null {
  const spec = formatFor(config, channelKey);
  if (!spec) return null;
  const hints: Partial<Record<ChannelFormat, string>> = {
    discord: 'Discord renders standard markdown natively (bold, italic, code blocks, links); tables are NOT supported. Use bullet lists or labeled lines.',
    slack: 'Standard markdown is auto-converted to Slack formatting (bold, headers, links, code); tables are NOT supported. Use bullet lists or labeled lines.',
    matrix: 'Your markdown converts to HTML: bold, italic, code, headings, lists, blockquotes, and links render. Do not use tables; use labeled lines or bullets. Avoid spoilers, strikethrough, and checkboxes. Prefer descriptive links.',
    signal: 'Standard markdown (bold, italic, strike, headers, code) auto-converts to Signal formatting; bullets render. No tables; use bullets or labeled lines.',
    mattermost: 'Mattermost renders standard Markdown: headings, bold, italic, code blocks, and tables all work.',
    whatsapp: 'Standard markdown auto-converts to WhatsApp formatting (bold, italic, strike, monospace). No tables; use bullets or labeled lines.',
    google_chat: 'Google Chat renders limited markdown: bold, italic, strike, code. No headings or lists. Use labeled lines instead of tables.',
  };
  return `${channelKey}: ${hints[spec] || 'Keep responses concise and use plain text only, with no visible markdown formatting. Be brief and direct. No tables; use labeled lines.'} Write standard markdown for conversion, never native platform dialect syntax.`;
}

const WIDE_RANGES: [number, number][] = [[4352,4447],[8986,8987],[9001,9002],[9193,9196],[9200,9200],[9203,9203],[9725,9726],[9748,9749],[9776,9783],[9800,9811],[9855,9855],[9866,9871],[9875,9875],[9889,9889],[9898,9899],[9917,9918],[9924,9925],[9934,9934],[9940,9940],[9962,9962],[9970,9971],[9973,9973],[9978,9978],[9981,9981],[9989,9989],[9994,9995],[10024,10024],[10060,10060],[10062,10062],[10067,10069],[10071,10071],[10133,10135],[10160,10160],[10175,10175],[11035,11036],[11088,11088],[11093,11093],[11904,11929],[11931,12019],[12032,12245],[12272,12350],[12353,12438],[12441,12543],[12549,12591],[12593,12686],[12688,12773],[12783,12830],[12832,12871],[12880,42124],[42128,42182],[43360,43388],[44032,55203],[63744,64255],[65040,65049],[65072,65106],[65108,65126],[65128,65131],[65281,65376],[65504,65510],[94176,94180],[94192,94193],[94208,100343],[100352,101589],[101631,101640],[110576,110579],[110581,110587],[110589,110590],[110592,110882],[110898,110898],[110928,110930],[110933,110933],[110948,110951],[110960,111355],[119552,119638],[119648,119670],[126980,126980],[127183,127183],[127374,127374],[127377,127386],[127488,127490],[127504,127547],[127552,127560],[127568,127569],[127584,127589],[127744,127776],[127789,127797],[127799,127868],[127870,127891],[127904,127946],[127951,127955],[127968,127984],[127988,127988],[127992,128062],[128064,128064],[128066,128252],[128255,128317],[128331,128334],[128336,128359],[128378,128378],[128405,128406],[128420,128420],[128507,128591],[128640,128709],[128716,128716],[128720,128722],[128725,128727],[128732,128735],[128747,128748],[128756,128764],[128992,129003],[129008,129008],[129292,129338],[129340,129349],[129351,129535],[129648,129660],[129664,129673],[129679,129734],[129742,129756],[129759,129769],[129776,129784],[131072,196605],[196608,262141]];
