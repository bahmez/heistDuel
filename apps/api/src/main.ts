import { createServer } from "node:http";
import { projectName } from "@repo/shared";

const port = Number(process.env.PORT ?? 8080);

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      service: "api",
      project: projectName,
      status: "ok"
    })
  );
});

server.listen(port, () => {
  // Keep this log concise for Cloud Run startup logs.
  console.log(`API running on port ${port}`);
});
