/*******************************************************
 *      Server Starts From Here                        *
 *******************************************************/
"use strict";

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  require("dotenv").config({ path: envPath });
} else {
  console.warn("[Server] .env file not found. Using default environment variables.");
}

const http = require("http");
const app = require("./app");

const port = process.env.PORT || 4000;
const env = process.env.NODE_ENV || "development";
const server = http.createServer(app);

app.set("PORT_NUMBER", port);

//  Start the app on the specific interface (and port).
server.listen(port, () => {
  // Keep the visual separator for development
  if (env === 'development') {
    console.log(`Server is running on ${port} successfully!`);
  }
});

module.exports = server;
