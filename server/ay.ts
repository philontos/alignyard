import { runAy } from "./protocol/cli.js";

process.exitCode = await runAy(process.argv.slice(2), {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
});
