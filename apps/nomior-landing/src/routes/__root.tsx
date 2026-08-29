import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles/app.css?url";

const TITLE = "Nomior Code";
const SOCIAL_TITLE = "Nomior Code — your project's memory, in the app where you code";
const DESCRIPTION =
  "Nomior Code is a local-first workspace for coding agents: bounded context with citations, verified memory, meetings, multi-account instances and independent review — on your machine, on the provider subscriptions you already have. In development.";
const URL = "https://code.nomior.com/";

const NOSCRIPT_REVEAL_CSS =
  "[data-reveal]{opacity:1!important;transform:none!important;translate:none!important}";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "theme-color", content: "#0E0D0B" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: SOCIAL_TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:url", content: URL },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: SOCIAL_TITLE },
      { name: "twitter:description", content: DESCRIPTION },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "canonical", href: URL },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="font-sans text-cream">
        {/*
         * Motion serializes each reveal's `initial` as an inline style during
         * SSR, so with scripting off the page would render blank below the
         * fold. Undo it for the no-JS render; with JS the animations run.
         */}
        <noscript>
          <style>{NOSCRIPT_REVEAL_CSS}</style>
        </noscript>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
