import { boot } from "./server.js";

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
