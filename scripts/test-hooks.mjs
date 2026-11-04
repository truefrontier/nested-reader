// Lets `node --test` load the app's TypeScript the way Vite does. Node strips the types itself;
// this adds the extensionless relative imports Vite allows (`./markdown` is `./markdown.ts`).
// DOMPurify only works against a browser DOM, so tests get a stand-in that passes HTML through:
// nothing under test here is about sanitising, and the app itself always runs the real one.
import { registerHooks } from "node:module";

const PURIFY = "data:text/javascript,export default { sanitize: (html) => html, addHook() {} };";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "dompurify") return { url: PURIFY, shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (err) {
      if (err?.code !== "ERR_MODULE_NOT_FOUND" || !/^\.\.?\//.test(specifier)) throw err;
      return next(`${specifier}.ts`, context);
    }
  },
});
