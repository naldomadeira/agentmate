import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts", "src/jobs-server.ts"],
  format: "esm",
  dts: true,
  clean: true,
  publint: true,
});
