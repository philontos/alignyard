import { createServer } from "node:http";
import { createPlatformApp } from "./app.js";
import { attachPlatformWs } from "../http/platform-ws.js";

const port = Number(process.env.PORT || 4500);
const host = process.env.HOST || "0.0.0.0";
const server = createServer(createPlatformApp());
attachPlatformWs(server);

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => {
    server.off("error", reject);
    process.stdout.write(`Alignyard platform listening on http://${host}:${port}\n`);
    resolve();
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => { process.exitCode = 0; }));
}
