#!/usr/bin/env bun

// Stub HTTP proxy for cli.test.ts: appends each request line (the CONNECT
// target for HTTPS) to the log file given as argv[2], then refuses the tunnel,
// so nothing reaches the real host. Prints its port on stdout once listening.

import { createServer, type AddressInfo } from "node:net";
import { appendFileSync } from "node:fs";

const log = process.argv[2];

const server = createServer((c) =>
  c.once("data", (b) => {
    appendFileSync(log, b.toString().split("\r\n")[0] + "\n");
    c.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  })
);
server.listen(0, "127.0.0.1", () => process.stdout.write(`${(server.address() as AddressInfo).port}\n`));
