// The real entry point (main.ts) in a child process, run from source.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("listens on PORT, serves requests and shuts down on SIGTERM", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "--conditions=source", "src/server/main.ts"], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    // Fastify logs JSON lines; the first one says where it listens.
    let base = "";
    for await (const line of createInterface({ input: child.stdout })) {
      const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
      if (match?.[1]) {
        base = match[1];
        break;
      }
    }
    const res = await fetch(`${base}/presets`);
    assert.equal(res.status, 200);
    assert.ok("ecommerce" in ((await res.json()) as object));

    // Windows has no catchable SIGTERM for child processes: kill() just terminates.
    if (process.platform === "win32") return;
    child.kill("SIGTERM");
    const [code] = (await once(child, "exit")) as [number | null];
    assert.equal(code, 0);
  } finally {
    child.kill("SIGKILL");
  }
});
