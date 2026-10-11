import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts", "src/simulate.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Workspace packages ship TypeScript source; bundle them. npm deps stay external.
  noExternal: [/^@sb\//],
  // Every npm package (listed in this package.json so pnpm links it) stays external.
  external: ["pg-native", /^(?!@sb\/)(@[^/]+\/)?[a-z0-9][^/]*/],
});
