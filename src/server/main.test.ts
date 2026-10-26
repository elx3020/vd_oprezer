// The real entry point (main.ts) in a child process, run from source.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("listens on PORT, logs its config with AUTH_KEY redacted, serves requests and shuts down on SIGTERM", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "--conditions=source", "src/server/main.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0", CORS_ORIGINS: "https://demo.example, https://b.example", AUTH_KEY: "s3cret" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    // Fastify logs JSON lines: the config, then where it listens.
    let base = "";
    let config = "";
    for await (const line of createInterface({ input: child.stdout })) {
      if (line.includes('"msg":"config"')) config = line;
      const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
      if (match?.[1]) {
        base = match[1];
        break;
      }
    }
    assert.match(config, /"authKey":"\*\*\*"/);
    assert.ok(!config.includes("s3cret"));
    assert.equal((await fetch(`${base}/presets`)).status, 401);
    const auth = { authorization: "Bearer s3cret" };
    const res = await fetch(`${base}/presets`, { headers: auth });
    assert.equal(res.status, 200);
    assert.ok("ecommerce" in ((await res.json()) as object));
    // CORS_ORIGINS is split on commas and trimmed.
    const cors = await fetch(`${base}/presets`, { headers: { origin: "https://b.example", ...auth } });
    assert.equal(cors.headers.get("access-control-allow-origin"), "https://b.example");

    // Windows has no catchable SIGTERM for child processes: kill() just terminates.
    if (process.platform === "win32") return;
    child.kill("SIGTERM");
    const [code] = (await once(child, "exit")) as [number | null];
    assert.equal(code, 0);
  } finally {
    child.kill("SIGKILL");
  }
});
