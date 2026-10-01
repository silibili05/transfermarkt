import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(scriptsDirectory, "..", "dist");

await rm(outputDirectory, { recursive: true, force: true });
console.log("Removed dist.");
