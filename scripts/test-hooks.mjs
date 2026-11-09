// Lets `node --test` load the app's TypeScript the way Vite does. Node strips the types itself;
// this adds the extensionless relative imports Vite allows (`./markdown` is `./markdown.ts`), and
// the directory, JSON and `?raw` imports the store and the mock platform use, so a test can load them.
// DOMPurify only works against a browser DOM, so tests get a stand-in that passes HTML through:
// nothing under test here is about sanitising, and the app itself always runs the real one.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const PURIFY = "data:text/javascript,export default { sanitize: (html) => html, addHook() {} };";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "dompurify") return { url: PURIFY, shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (err) {
      if (!/^\.\.?\//.test(specifier)) throw err;
      if (err?.code === "ERR_MODULE_NOT_FOUND") return next(`${specifier}.ts`, context);
      if (err?.code === "ERR_UNSUPPORTED_DIR_IMPORT") return next(`${specifier}/index.ts`, context);
      throw err;
    }
  },
  load(url, context, next) {
    // Vite reads JSON without an import attribute, and lets each top-level key be imported by name.
    if (url.endsWith(".json")) {
      const json = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
      const named = Object.keys(json).filter((k) => k !== "default").map((k, i) => `const v${i} = json[${JSON.stringify(k)}]; export { v${i} as ${JSON.stringify(k)} };`);
      return { format: "module", source: [`const json = ${JSON.stringify(json)};`, "export default json;", ...named].join("\n"), shortCircuit: true };
    }
    // Vite's `?raw` hands over a file's text, as the mock platform's sample pages are imported.
    if (url.endsWith("?raw")) return { format: "module", source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), "utf8"))};`, shortCircuit: true };
    return next(url, context);
  },
});
