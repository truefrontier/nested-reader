import { createServer } from "node:http";
import { nodeHandler } from "./handler.js";

const PORT = process.env.PORT || 8080;
const env = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPO: process.env.GITHUB_REPO || "truefrontier/nested-reader",
  LABEL: process.env.LABEL || "feedback",
  ATTACHMENTS_BRANCH: process.env.ATTACHMENTS_BRANCH,
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
};

// Fly sets FLY_APP_NAME on its machines; only there does Fly-Client-IP come from Fly's proxy.
const server = createServer(nodeHandler(env, { behindFly: Boolean(process.env.FLY_APP_NAME) }));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Feedback relay listening on http://0.0.0.0:${PORT}`);
});
