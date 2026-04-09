import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const fixtureDir = resolve(repoRoot, "test/fixtures/cloudflare-app");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function prefixLines(text, prefix) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function run(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", resolvePromise);
  });

  if (exitCode !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        prefixLines(stdout, "stdout: "),
        prefixLines(stderr, "stderr: "),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return { stdout, stderr };
}

function startServer(scriptName, port) {
  const child = spawn(
    npmCmd,
    ["run", scriptName, "--", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: fixtureDir,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let logs = "";
  let exited = false;

  const append = (chunk) => {
    logs += chunk.toString();
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("close", () => {
    exited = true;
  });

  return {
    child,
    get logs() {
      return logs;
    },
    get exited() {
      return exited;
    },
  };
}

async function stopServer(server) {
  if (server.child.exitCode !== null || server.child.killed) {
    return;
  }

  server.child.kill("SIGTERM");
  const closed = await Promise.race([
    new Promise((resolvePromise) => {
      server.child.once("close", resolvePromise);
    }),
    sleep(5_000).then(() => false),
  ]);

  if (!closed && server.child.exitCode === null) {
    server.child.kill("SIGKILL");
    await new Promise((resolvePromise) => {
      server.child.once("close", resolvePromise);
    });
  }
}

async function waitForHttp(url, server, label) {
  const startedAt = Date.now();
  let lastError = "no response received";

  while (Date.now() - startedAt < 60_000) {
    if (server.exited) {
      throw new Error(
        `${label} exited before becoming ready.\n${prefixLines(server.logs, "log: ")}`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = `${response.status} ${response.statusText}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for ${label} at ${url}: ${lastError}\n${prefixLines(server.logs, "log: ")}`,
  );
}

async function assertPage(baseUrl, server, label) {
  const response = await waitForHttp(baseUrl, server, label);
  const html = await response.text();

  if (!html.includes("cloudflare smoke")) {
    throw new Error(
      `${label} HTML did not include smoke marker.\n${prefixLines(server.logs, "log: ")}`,
    );
  }

  if (!html.includes("manifest.webmanifest")) {
    throw new Error(
      `${label} HTML did not include favicon manifest tags.\n${prefixLines(server.logs, "log: ")}`,
    );
  }

  if (!html.includes("apple-touch-icon")) {
    throw new Error(
      `${label} HTML did not include generated apple icon tags.\n${prefixLines(server.logs, "log: ")}`,
    );
  }
}

async function assertManifest(baseUrl, server, label) {
  const response = await waitForHttp(
    `${baseUrl.replace(/\/$/, "")}/manifest.webmanifest`,
    server,
    `${label} manifest`,
  );
  const text = await response.text();

  if (!text.includes("Cloudflare Smoke")) {
    throw new Error(
      `${label} manifest did not include the configured app name.\n${prefixLines(server.logs, "log: ")}`,
    );
  }
}

async function assertBuiltAssets() {
  const manifest = await readFile(
    resolve(fixtureDir, "dist/server/manifest.webmanifest"),
    "utf8",
  );

  if (!manifest.includes("Cloudflare Smoke")) {
    throw new Error("Build output manifest.webmanifest did not include the configured app name.");
  }
}

async function main() {
  const packDir = await mkdtemp(resolve(tmpdir(), "astro-favicons-smoke-"));
  let server;

  console.log("Building package under test...");
  try {
    await run(npmCmd, ["run", "build"], repoRoot);

    console.log("Packing publishable tarball...");
    const { stdout: packStdout } = await run(
      npmCmd,
      ["pack", "--pack-destination", packDir],
      repoRoot,
    );
    const tarballName = packStdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    if (!tarballName?.endsWith(".tgz")) {
      throw new Error(`Unable to determine packed tarball name from npm pack output:\n${packStdout}`);
    }

    const tarballPath = resolve(packDir, tarballName);

    console.log("Installing Cloudflare fixture dependencies...");
    await rm(resolve(fixtureDir, "node_modules"), { recursive: true, force: true });
    await rm(resolve(fixtureDir, "package-lock.json"), { force: true });
    await run(
      npmCmd,
      ["install", "--no-fund", "--no-audit", "--no-package-lock"],
      fixtureDir,
    );
    await run(
      npmCmd,
      ["install", "--no-save", "--no-fund", "--no-audit", "--no-package-lock", tarballPath],
      fixtureDir,
    );

    console.log("Building Cloudflare fixture...");
    await run(npmCmd, ["run", "build"], fixtureDir);
    await assertBuiltAssets();

    console.log("Starting Cloudflare dev smoke test...");
    server = startServer("dev", 4325);
    await assertPage("http://127.0.0.1:4325/", server, "dev");
    await assertManifest("http://127.0.0.1:4325/", server, "dev");
    await stopServer(server);

    console.log("Starting Cloudflare preview smoke test...");
    server = startServer("preview", 4326);
    await assertPage("http://127.0.0.1:4326/", server, "preview");
    await assertManifest("http://127.0.0.1:4326/", server, "preview");
    await stopServer(server);
  } finally {
    if (server) {
      await stopServer(server);
    }
    await rm(packDir, { recursive: true, force: true });
  }

  console.log("Cloudflare smoke tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
