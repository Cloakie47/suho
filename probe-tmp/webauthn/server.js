const http = require("http");
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "index.html"));
http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      fs.writeFileSync(path.join(__dirname, "webauthn-result.json"), body);
      console.log("result logged");
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }).end(html);
}).listen(8377, "127.0.0.1", () => console.log("probe E on http://localhost:8377"));
