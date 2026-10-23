// Composition root for the server: the only file that reads env vars.
import { describeServer } from "./index.js";

const port = Number(process.env.PORT ?? 3000);
console.log(describeServer({ port }));
