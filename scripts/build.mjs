import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["zot-mcp.ts"],
  outfile: "dist/zot-mcp.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  sourcemap: false,
  legalComments: "eof",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const output = "dist/zot-mcp.js";
const bundled = await readFile(output, "utf8");
await writeFile(output, bundled.replace(/[ \t]+$/gm, ""));
await chmod(output, 0o755);
