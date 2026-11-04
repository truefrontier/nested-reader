import { createServer } from "node:http";
import { nodeHandler } from "./handler.js";

const PORT = process.env.PORT || 8080;
const env = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPO: process.env.GITHUB_REPO || "truefrontier/nested-reader",
  LABEL: process.env.LABEL || "feedback",
  ATTACHMENTS_BRANCH: process.env.ATTACHMENTS_BRANCH,
};

const server = createServer(nodeHandler(env));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Feedback relay listening on http://0.0.0.0:${PORT}`);
});
