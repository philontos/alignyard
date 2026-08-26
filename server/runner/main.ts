import { runRunnerCli } from "./cli.js";

process.exitCode = await runRunnerCli(
  process.argv.slice(2),
  (message) => process.stdout.write(message + "\n"),
  (message) => process.stderr.write(message + "\n"),
);
