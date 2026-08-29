import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "~/styles/app.css?url";

const TITLE = "Nomior Code";
const SOCIAL_TITLE = "Nomior Code — your project's memory, in the app where you code";
const DESCRIPTION =
  "Nomior Code is a local-first workspace for coding agents: bounded context with citations, verified memory, meetings, multi-account instances and independent review — on your machine, on your own subscriptions.";
const URL = "https://code.nomior.com/";

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
        {children}
        <Scripts />
      </body>
    </html>
  );
}
