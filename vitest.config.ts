import { defineConfig } from "vitest/config";

// Match tsup's `.html` text loader (tsup.config.ts) so `import html from
// './generated/index.html'` returns the file's contents as a string under
// vitest too. Without this, vite's import-analysis tries to parse the built
// console HTML as JS and fails.
export default defineConfig({
  test: {
    // Strip the env vars the running bridge injects into its agent children, so
    // the suite behaves the same whether it is launched from a terminal or from
    // inside a bridge-spawned agent session. See the file for the specifics.
    setupFiles: ["./tests/setup/scrub-bridge-env.ts"],
  },
  plugins: [
    {
      name: "html-string-loader",
      enforce: "pre",
      transform(code: string, id: string) {
        if (id.endsWith(".html")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
        return null;
      },
    },
  ],
});
