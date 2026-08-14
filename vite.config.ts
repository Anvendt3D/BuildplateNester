import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
    base: process.env.GITHUB_PAGES === "true" ? "./" : "/",
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
    },
    plugins: [vinext()],
});
