import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("autobox requires Apple Silicon macOS");
}
execFileSync("/usr/bin/clang", [
  "-O2", "-Wall", "-Wextra", "-Werror",
  fileURLToPath(new URL("../src/clonefile.c", import.meta.url)),
  "-o", fileURLToPath(new URL("../dist/autobox-clone", import.meta.url)),
], { stdio: "inherit" });
