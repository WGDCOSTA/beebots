// The Arena as its own process: `pnpm arena`. It shares no database, settings file or key with the owner's engine and
// admin panel, which is the whole point: the platform's owner has no route to a user's data.
//   ARENA_DIR          where the directory database and the per-user files live (default ./data/arena)
//   ARENA_BASE_URL     the public address of the sign-in page (default http://localhost:5173)
//   ARENA_PORT / ARENA_BIND   (default 8090 / 127.0.0.1)
//   ARENA_MAIL_API_KEY + ARENA_MAIL_FROM   send real e-mail through Resend; without them links are printed to the log
import { createServer } from "node:http";
import { log } from "../log.js";
import { ArenaApi } from "./api.js";
import { ArenaAuth } from "./auth.js";
import { ConsoleMailer, ResendMailer, type Mailer } from "./mailer.js";
import { ArenaStore } from "./store.js";

const env = process.env;
const baseUrl = env.ARENA_BASE_URL ?? "http://localhost:5173";
const mailer: Mailer = env.ARENA_MAIL_API_KEY && env.ARENA_MAIL_FROM ? new ResendMailer(env.ARENA_MAIL_API_KEY, env.ARENA_MAIL_FROM) : new ConsoleMailer();
if (mailer instanceof ConsoleMailer) log.warn("arena: no mail provider configured, sign-in links are printed to the log (development only)");

const store = new ArenaStore(env.ARENA_DIR ?? "./data/arena");
const api = new ArenaApi(new ArenaAuth(store, mailer, { baseUrl }), store, { secureCookie: baseUrl.startsWith("https://") });

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  void api.handle(req, res, path).then((handled) => {
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
    }
  }).catch((e) => {
    log.error("arena request failed", { error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"request failed"}');
  });
});

const port = Number(env.ARENA_PORT ?? 8090);
const bind = env.ARENA_BIND ?? "127.0.0.1";
server.listen(port, bind, () => log.info("arena listening", { port, bind }));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    server.close();
    store.close();
    process.exit(0);
  });
