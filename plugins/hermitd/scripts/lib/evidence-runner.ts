export async function runEvidence(cmd: string, root: string, timeoutS: number) {
  const proc = Bun.spawn(['bash', '-c', cmd], { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
  // A backgrounded grandchild inherits the pipes and keeps them open after the
  // kill, so the deadline must also stop waiting on EOF, not just kill the child.
  let deadline: (() => void) | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
    for (const reader of readers) void reader.cancel();
    deadline?.();
  }, Number(process.env.LATER_CHECK_TIMEOUT_MS) || timeoutS * 1000); // env: test-only seam
  async function drain(reader: (typeof readers)[number]) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const kept = Buffer.from(value.subarray(0, Math.max(0, 2048 - size)));
      if (kept.length) chunks.push(kept);
      size += kept.length;
    }
  }
  try {
    const drained = Promise.all([drain(readers[0]), drain(readers[1])]);
    const exit = await proc.exited;
    try { process.kill(-proc.pid, 'SIGKILL'); }
    catch { /* best effort: the group is already gone */ }
    if (!timedOut) {
      await Promise.race([drained, new Promise<void>(resolve => { deadline = resolve; })]);
    }
    return { exit, output: new TextDecoder('utf-8').decode(Buffer.concat(chunks), { stream: true }), timed_out: timedOut };
  } finally { clearTimeout(timer); }
}
