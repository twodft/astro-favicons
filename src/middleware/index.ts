import { html, opts } from "virtual:astro-favicons";
import { defineMiddleware, sequence } from "astro/middleware";
import capo from "./capo";

const injectionMarker = "<!-- astro-favicons -->";
const headCloseTag = "</head>";
const headScanLimit = 64 * 1024;

const useLocaleName = (locale?: string) => {
  if (!locale) return opts.name;

  const localized = opts.name_localized?.[locale];
  if (!localized) return opts.name;

  return typeof localized === "string" ? localized : localized.value;
};

export const localizedHTML = (locale?: string) => {
  if (html.length === 0) return "";

  const namePattern =
    /(name="(application-name|apple-mobile-web-app-title)")\scontent="[^"]*"/;

  const tags = html
    .map((line) =>
      line.replace(namePattern, `name="$2" content="${useLocaleName(locale)}"`),
    )
    .join("\n");

  return `${injectionMarker}\n${tags}`;
};

const hasInjectedHTML = (head: string) =>
  head.includes(injectionMarker) || html.some((line) => head.includes(line));

async function readHeadSnippet(res: Response): Promise<string> {
  if (!res.body) {
    return "";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let scanned = 0;
  let snippet = "";

  try {
    while (scanned < headScanLimit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      scanned += value.byteLength;
      snippet += decoder.decode(value, { stream: true });

      const headIndex = snippet.indexOf(headCloseTag);
      if (headIndex !== -1) {
        return snippet.slice(0, headIndex + headCloseTag.length);
      }
    }

    snippet += decoder.decode();
    const headIndex = snippet.indexOf(headCloseTag);
    return headIndex === -1 ? snippet : snippet.slice(0, headIndex + headCloseTag.length);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors from the peek-only clone reader.
    }
  }
}

const withCapo = defineMiddleware(async (ctx, next) => {
  const res = await next();
  try {
    if (html.length === 0 || opts.disableMiddleware) throw "done";

    if (res.headers.get("X-Astro-Route-Type") !== "page") {
      return res;
    }

    const head = await readHeadSnippet(res.clone());
    if (hasInjectedHTML(head)) {
      return res;
    }

    const doc = await res.clone().text();
    const headIndex = doc.indexOf(headCloseTag);

    if (headIndex === -1) throw "done";

    const document = `${doc.slice(0, headIndex)}\n${localizedHTML(ctx.currentLocale)}\n${doc.slice(headIndex)}`;

    return new Response(opts.withCapo ? capo(document) : document, {
      status: res.status,
      headers: res.headers,
    });
  } catch (e) {
    if (e !== "done") {
      console.error("Error in withCapo middleware:", e);
    }
    return res;
  }
});

export const onRequest = sequence(withCapo);
