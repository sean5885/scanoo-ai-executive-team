import { startHttpServer } from "./http-server.mjs";

const server = startHttpServer();

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
