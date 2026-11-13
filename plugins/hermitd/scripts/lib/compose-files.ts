import fs from 'node:fs';
import path from 'node:path';

/** Select the stack in precedence order; operator overrides win. */
export function composeFiles(projectRoot: string): string[] {
  const optional = ['docker-compose.security.yml', 'docker-compose.override.yml']
    .map((file) => path.join(projectRoot, file))
    .filter((full) => fs.existsSync(full));
  return [path.join(projectRoot, 'docker-compose.hermit.yml'), ...optional].flatMap((full) => ['-f', full]);
}
