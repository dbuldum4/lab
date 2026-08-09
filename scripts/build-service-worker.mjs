import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const outputDirectory = join(process.cwd(), "out");
const basePath = process.env.LAB_GITHUB_PAGES_BUILD === "true" ? "/lab" : "";
const ignoredExtensions = new Set([".map"]);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function outputUrl(file) {
  const path = relative(outputDirectory, file).split(sep).join("/");
  if (path === "index.html") return `${basePath || ""}/`;
  return `${basePath}/${path}`.replace(/^\/\//, "/");
}

const manifestPath = join(outputDirectory, "manifest.webmanifest");
await stat(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.name !== "lab" || manifest.display !== "standalone") {
  throw new Error("The generated PWA manifest is incomplete.");
}

const files = (await filesUnder(outputDirectory))
  .filter((file) => !file.endsWith("/sw.js") && !ignoredExtensions.has(file.slice(file.lastIndexOf("."))))
  .sort();
const precacheUrls = [...new Set(files.map(outputUrl))];
const appRoot = `${basePath || ""}/`;
if (!precacheUrls.includes(appRoot)) throw new Error("The static app root is missing from the offline precache.");
if (!precacheUrls.some((url) => url.includes("/_next/static/"))) {
  throw new Error("No Next.js static assets were found for offline precaching.");
}

const cacheVersion = createHash("sha256").update(precacheUrls.join("\n")).digest("hex").slice(0, 12);
const source = `const CACHE_NAME = ${JSON.stringify(`lab-shell-${cacheVersion}`)};
const APP_ROOT = ${JSON.stringify(appRoot)};
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("lab-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match(APP_ROOT)) || Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
      return response;
    })),
  );
});
`;

await writeFile(join(outputDirectory, "sw.js"), source, "utf8");
console.log(`Generated out/sw.js with ${precacheUrls.length} precached files (${cacheVersion}).`);
