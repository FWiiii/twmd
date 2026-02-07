#!/usr/bin/env node
import { createSessionStore } from "@twmd/core";

function main(): void {
  const sessionStore = createSessionStore({
    appName: "tw-media-downloader"
  });

  const [, , ...args] = process.argv;
  const command = args[0] ?? "help";

  if (command === "help") {
    console.log("twmd CLI initialized. Available next: login/download/whoami/logout");
    console.log(`session store path: ${sessionStore.path}`);
    return;
  }

  console.log(`command not implemented yet: ${command}`);
}

main();
