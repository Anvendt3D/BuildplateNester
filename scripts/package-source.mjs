import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";

const root = process.cwd();
const archiveName = "printnest-complete-source.zip";
const manifestName = "printnest-source-manifest.txt";
const directories = [".openai", "app", "build", "db", "drizzle", "examples", "public", "scripts", "tests", "worker"];
const rootFiles = [
  "README.md",
  "drizzle.config.ts",
  "eslint.config.mjs",
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "tsconfig.json",
  "vite.config.ts",
];
const excluded = new Set([
  `public/${archiveName}`,
  `public/${manifestName}`,
  "tsconfig.tsbuildinfo",
]);

async function collect(relativePath) {
  if (excluded.has(relativePath)) return [];
  const absolutePath = path.join(root, relativePath);
  const info = await stat(absolutePath);
  if (info.isFile()) return [relativePath];
  const entries = await readdir(absolutePath);
  const nested = await Promise.all(entries.sort().map((entry) => collect(path.join(relativePath, entry))));
  return nested.flat();
}

const candidates = [...rootFiles];
for (const directory of directories) candidates.push(...await collect(directory));
const files = [...new Set(candidates)].filter((file) => !excluded.has(file)).sort();

const manifest = [
  "PrintNest complete project source",
  "",
  "This archive contains the complete deployable project: application source, nesting and orientation workers, server/Worker entry, database schema, build configuration, tests, browser assets, and locked dependencies.",
  "Generated dependencies, build output, local caches, Git metadata, and secrets are intentionally excluded.",
  "",
  ...files,
  "",
].join("\n");

const archive = { "printnest-step/SOURCE-MANIFEST.txt": strToU8(manifest) };
for (const file of files) archive[`printnest-step/${file}`] = new Uint8Array(await readFile(path.join(root, file)));

await writeFile(path.join(root, "public", manifestName), manifest);
await writeFile(path.join(root, "public", archiveName), zipSync(archive, { level: 9 }));
console.log(`Packaged ${files.length} project files in public/${archiveName}`);
