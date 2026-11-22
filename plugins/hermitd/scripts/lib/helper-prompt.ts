import { renderTemplate } from './render-template';

export function selectHelperTransport(template: string, transport: 'local' | 'cloud'): string {
  return template.replace(/^<!-- helper:(local|cloud) -->\n([\s\S]*?)^<!-- \/helper:\1 -->\n/gm,
    (_block, variant, text) => variant === transport ? text : '');
}

export function renderHelperPrompt(
  template: string, transport: 'local' | 'cloud', vars: Record<string, string>,
): string {
  return renderTemplate(selectHelperTransport(template, transport), vars);
}
