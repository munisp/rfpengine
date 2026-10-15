import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";
import { isLocalTestMode } from "./localTestMode";

/** Only a literal boolean marker is injected; environment values never enter HTML. */
export function injectLocalTestModeMarker(
  template: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (!isLocalTestMode(env)) return template;
  return template.replace(/<html\b([^>]*)>/i, (tag, attributes: string) => {
    if (/\bdata-local-test\s*=/i.test(attributes)) return tag;
    return `<html${attributes} data-local-test="true">`;
  });
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(
        url,
        injectLocalTestModeMarker(template)
      );
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  // index:false sends all HTML through the marker injector below. Assets retain
  // normal static caching and never receive configuration-derived markup.
  app.use(express.static(distPath, { index: false }));

  // fall through to index.html if the file doesn't exist
  app.use("*", async (_req, res, next) => {
    try {
      const template = await fs.promises.readFile(
        path.resolve(distPath, "index.html"),
        "utf-8"
      );
      res.type("html").send(injectLocalTestModeMarker(template));
    } catch (error) {
      next(error);
    }
  });
}
