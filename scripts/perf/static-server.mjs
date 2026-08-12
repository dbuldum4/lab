import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

async function resolveFile(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  if (isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return null;
  let target = resolve(root, relative || "index.html");
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
  try {
    const details = await stat(target);
    if (details.isDirectory()) target = join(target, "index.html");
    const fileDetails = await stat(target);
    return fileDetails.isFile() ? target : null;
  } catch {
    return null;
  }
}

export async function startStaticServer(rootDirectory, requestedPort = 0, basePath = "") {
  const root = resolve(rootDirectory);
  const normalizedBasePath = basePath
    ? `/${basePath.replace(/^\/+|\/+$/g, "")}`
    : "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestPath = normalizedBasePath === ""
      ? url.pathname
      : url.pathname === normalizedBasePath
        ? "/"
        : url.pathname.startsWith(`${normalizedBasePath}/`)
          ? url.pathname.slice(normalizedBasePath.length)
          : null;
    const file = requestPath === null ? null : await resolveFile(root, requestPath);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": CONTENT_TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream",
    });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The static server has no TCP address.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  const port = Number.parseInt(process.argv[3] ?? "3101", 10);
  const basePath = process.argv[4] ?? "";
  if (!root || !Number.isInteger(port) || port < 1 || port > 65_535 || (basePath && !basePath.startsWith("/"))) {
    console.error("Usage: node scripts/perf/static-server.mjs <directory> [port] [basePath]");
    process.exit(64);
  }
  const running = await startStaticServer(root, port, basePath);
  console.log(`Serving ${resolve(root)} at ${running.url}${basePath}`);
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
