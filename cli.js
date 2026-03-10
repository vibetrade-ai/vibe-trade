#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { join } = require("path");
const { existsSync } = require("fs");

const PKG_ROOT = __dirname;
const PORT = process.env.PORT ?? "3001";
const SERVER_SCRIPT = join(PKG_ROOT, "backend", "dist", "server.js");

if (!existsSync(SERVER_SCRIPT)) {
  console.error("VibeTrade backend not found. Did you run `npm run build`?");
  process.exit(1);
}

const server = spawn("node", [SERVER_SCRIPT], {
  cwd: PKG_ROOT,
  env: { ...process.env, PORT },
  stdio: ["ignore", "ignore", "ignore"],
});

server.on("error", (err) => {
  console.error("Failed to start VibeTrade:", err.message);
  process.exit(1);
});

server.on("exit", (code) => {
  if (code !== null && code !== 0) process.exit(code);
});

// Poll the health endpoint, then open the browser
const url = `http://localhost:${PORT}`;

async function waitForServer(retries = 30, delayMs = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

waitForServer().then(async (ready) => {
  console.log(`
                                        
              ███  █████                  █████                            █████         
             ░░░  ░░███                  ░░███                            ░░███          
 █████ █████ ████  ░███████   ██████     ███████   ████████   ██████    ███████   ██████ 
░░███ ░░███ ░░███  ░███░░███ ███░░███   ░░░███░   ░░███░░███ ░░░░░███  ███░░███  ███░░███
 ░███  ░███  ░███  ░███ ░███░███████      ░███     ░███ ░░░   ███████ ░███ ░███ ░███████ 
 ░░███ ███   ░███  ░███ ░███░███░░░       ░███ ███ ░███      ███░░███ ░███ ░███ ░███░░░  
  ░░█████    █████ ████████ ░░██████      ░░█████  █████    ░░████████░░████████░░██████ 
   ░░░░░    ░░░░░ ░░░░░░░░   ░░░░░░        ░░░░░  ░░░░░      ░░░░░░░░  ░░░░░░░░  ░░░░░░  
                                                                                                                                                                                                                  
    `);
  console.log(`Click \x1b[34m\x1b[4m${url}\x1b[0m if it doesn't open automatically\n`);
  
  if (!ready) {
    console.warn("Server did not respond in time.");
  }
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch {
  }
});

// Forward signals to the child
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
