import { buildServer } from "./server.js";

const runtime = await buildServer();
await runtime.app.listen({ host: runtime.config.host, port: runtime.config.port });

const shutdown = async () => {
  await runtime.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
