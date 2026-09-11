#!/usr/bin/env bun
import { socketPath } from "../paths";
import { createApiClient } from "./api-client";
import { attach } from "./attach-runner";
import { runCli } from "./main";

runCli(process.argv.slice(2), createApiClient(socketPath()), {
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
  attach,
}).then((exitCode) => { process.exitCode = exitCode; });
