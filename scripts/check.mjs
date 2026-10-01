import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(scriptsDirectory, "..", "src");
const manifestPath = path.join(sourceDirectory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3.");
}

const referencedFiles = new Set([
  manifest.action.default_popup,
  ...(manifest.background?.service_worker ? [manifest.background.service_worker] : []),
  "fetcher.js",
  "logger.js",
  ...(manifest.options_page ? [manifest.options_page] : []),
  ...(manifest.content_scripts || []).flatMap((script) => [
    ...(script.js || []),
    ...(script.css || [])
  ])
]);

for (const file of referencedFiles) {
  await access(path.join(sourceDirectory, file));
}

console.log(`Manifest valid. Checked ${referencedFiles.size} referenced files.`);
