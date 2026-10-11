import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPilotRouter } from "./router.js";
import { createStoredPgxReader } from "./stored-pgx.js";
import { validateRegistration } from "./client.js";

// Standalone development harness. Never imported or mounted by the production Nest API.
async function start() {
  if (process.env.NODE_ENV === "production")
    throw new Error("Synthetic pilot cannot run in production");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const registration = validateRegistration(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "openemr/.runtime/registration.json"),
        "utf8",
      ),
    ),
  );
  const storedPath = path.join(root, "openemr/.runtime/stored-reader.json");
  if (fs.existsSync(storedPath) && (fs.statSync(storedPath).mode & 0o077) !== 0)
    throw new Error("Stored reader credentials require private file permissions");
  const storedReader = fs.existsSync(storedPath)
    ? createStoredPgxReader(JSON.parse(fs.readFileSync(storedPath, "utf8"))) : undefined;
  const origin = "http://127.0.0.1:8767";
  const dist = path.join(root, "dist-ui");
  if (!fs.existsSync(path.join(dist, "index.html")))
    throw new Error("Build the viewer first");
  const app = express();
  app.disable("x-powered-by");
  app.use(
    createPilotRouter({ origin, storedReader, registrations: { openemr: registration } }),
  );
  app.get("/", (_req, res) =>
    res
      .type("html")
      .send(
        "<h1>Synthetic SMART pilot</h1><p>Read-only. No clinical recommendations. Launch from the isolated OpenEMR patient chart.</p>",
      ),
  );
  app.get("/smart/evidence", (_req, res) =>
    res.sendFile(path.join(dist, "index.html")),
  );
  app.use(express.static(dist, { index: false }));
  const server = await new Promise<ReturnType<typeof app.listen>>(
    (resolve, reject) => {
      const listener = app.listen(8767, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    },
  );
  process.stdout.write(`Synthetic SMART pilot: ${origin}\n`);
  process.once("SIGTERM", () => server.close());
  process.once("SIGINT", () => server.close());
}
start().catch(() => {
  process.stderr.write(
    "Pilot startup failed; verify build, registration and local ports.\n",
  );
  process.exitCode = 1;
});
