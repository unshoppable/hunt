/**
 * A stand-in for a preview process in the preview's integration tests: serves HTTP on 127.0.0.1:$PORT, answers
 * `GET /env` with its working directory and environment and every other path with 200.
 */
import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.url === "/env") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ cwd: process.cwd(), env: process.env }));
    return;
  }
  response.end("ok");
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`listening on ${process.env.PORT}`));
