import { copyFileSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_FILENAME = "entry.png";
const DEFAULT_OUTPUT_DIR = "/output";
const MAX_IMAGE_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function resolveRepoDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return dirname(currentFile);
}

function resolveOutputDir(): string {
  const configured = process.env.MAKEFUN_OUTPUT_DIR;
  if (configured && configured.trim().length > 0) {
    return resolve(configured.trim());
  }
  return DEFAULT_OUTPUT_DIR;
}

function verifySourceImage(sourcePath: string): void {
  const stats = statSync(sourcePath);
  if (!stats.isFile()) {
    throw new Error(`Expected ${sourcePath} to be a regular file.`);
  }
  if (stats.size <= 0 || stats.size > MAX_IMAGE_BYTES) {
    throw new Error(`Invalid entry.png size: ${stats.size} bytes (limit ${MAX_IMAGE_BYTES}).`);
  }
  const header = Buffer.alloc(PNG_SIGNATURE.length);
  const fd = openSync(sourcePath, "r");
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  if (!header.equals(PNG_SIGNATURE)) {
    throw new Error(`Expected ${sourcePath} to begin with a valid PNG signature.`);
  }
}

function main(): void {
  const repoDir = resolveRepoDir();
  const sourcePath = join(repoDir, ENTRY_FILENAME);
  const outputDir = resolveOutputDir();
  const targetPath = join(outputDir, ENTRY_FILENAME);

  verifySourceImage(sourcePath);

  mkdirSync(outputDir, { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

main();
