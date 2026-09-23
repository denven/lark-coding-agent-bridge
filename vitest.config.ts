import { defineConfig } from "vitest/config";

// Match tsup's `.html` text loader (tsup.config.ts) so `import html from
// './generated/index.html'` returns the file's contents as a string under
// vitest too. Without this, vite's import-analysis tries to parse the built
// console HTML as JS and fails.
export default defineConfig({
  test: {
    // Log files are named by *local* date (formatLocalDateKey), and several
    // tests pin the clock to midnight UTC. Outside UTC that midnight falls on
    // another local day, so those tests look for a file that was never
    // written. Pin the test process to UTC, as CI already is.
    env: { TZ: 'UTC' },
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
