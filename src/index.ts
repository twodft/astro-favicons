import type { AstroIntegration } from "astro";
import { fileURLToPath } from "node:url";
import type { FaviconOptions, Input } from "./types";
import { defaults } from "./config/defaults";
import { handleAssets } from "./plugin";
import { integrationName, packageName } from "./config/packge";

export interface Options extends FaviconOptions {
  /**
   * Specify the source image(s) used to generate platform-specific assets.
   * @default `public/favicon.svg`.
   * @example
   * ```js
   * input: {
   *  yandex: ["public/favicon.svg", await readFile("path/to/pixel.png")]
   * }
   * ```
   */
  input?: Input;
  /**
   * Powered by `astro-capo`, it keeps the `<head>` content well-organized and tidy.
   * @default config.compressHTML `true`
   */
  withCapo?: boolean;
  /**
   * Disable the automatic middleware that injects and reorders favicon tags.
   * Use this together with manual `localizedHTML()` injection if you want full
   * control over the rendered `<head>`.
   * @default `false`
   */
  disableMiddleware?: boolean;
}

export default function createIntegration(options?: Options): AstroIntegration {
  const opts = { ...defaults, ...options };
  const middlewareEntry = fileURLToPath(new URL("./middleware.mjs", import.meta.url));

  return {
    name: integrationName,
    hooks: {
      "astro:config:setup": async ({
        config,
        isRestart,
        command: cmd,
        updateConfig,
        logger,
        addMiddleware,
      }) => {
        opts.withCapo = opts.withCapo ?? config.compressHTML;
        if (cmd === "build" || cmd === "dev") {
          if (!isRestart) {
            logger.info(`Processing source...`);
          }
          updateConfig({
            vite: {
              plugins: [await handleAssets(opts, { isRestart, logger })],
              resolve: {
                // Cloudflare's workerd dev pipeline can prebundle bare package
                // subpath imports before the virtual module is registered.
                alias: {
                  [`${packageName}/middleware`]: middlewareEntry,
                },
              },
              ssr: {
                noExternal: [packageName, `${packageName}/middleware`],
              },
            },
          });
        }
        if (!opts.disableMiddleware) {
          addMiddleware({
            entrypoint: `${packageName}/middleware`,
            order: "pre",
          });
        }
      },
    },
  };
}
