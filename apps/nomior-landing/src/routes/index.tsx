import { createFileRoute } from "@tanstack/react-router";

import { Boundaries } from "~/components/boundaries";
import { Features } from "~/components/features";
import { Footer } from "~/components/footer";
import { Hero } from "~/components/hero";
import { Loop } from "~/components/loop";
import { Nav } from "~/components/nav";
import { Pricing } from "~/components/pricing";
import { Status } from "~/components/status";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-cream focus:px-4 focus:py-2 focus:text-ink"
        href="#main"
      >
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Loop />
        <Features />
        <Boundaries />
        <Pricing />
        <Status />
      </main>
      <Footer />
    </>
  );
}
