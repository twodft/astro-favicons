import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import favicons from "@twodft/astro-favicons";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [
    favicons({
      name: "Cloudflare Smoke",
    }),
  ],
});
