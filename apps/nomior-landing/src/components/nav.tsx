import { useEffect, useState } from "react";

import { CodeMark } from "./marks";

const LINKS = [
  { href: "#loop", label: "Loop" },
  { href: "#features", label: "What it does" },
  { href: "#boundaries", label: "Boundaries" },
  { href: "#pricing", label: "Pricing" },
] as const;

export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const sentinel = document.getElementById("top-sentinel");
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry?.isIntersecting));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 border-b transition-[background-color,border-color,backdrop-filter] duration-500 ${
        scrolled ? "border-line/70 bg-ink/80 backdrop-blur-md" : "border-transparent"
      }`}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 w-full max-w-[1180px] items-center gap-6 px-5 md:px-10"
      >
        <a
          aria-label="Nomior Code, top of page"
          className="flex shrink-0 items-center gap-2.5"
          href="#top"
        >
          <CodeMark className="text-cream/80" size={24} />
          <span className="text-[15px] font-semibold tracking-tight">
            Nomior <span className="text-fog">Code</span>
          </span>
        </a>
        <div className="ms-auto flex items-center gap-6 font-mono text-xs text-fog">
          {LINKS.map((link) => (
            <a
              className={`transition-colors hover:text-cream ${
                link.href === "#pricing" ? "" : "hidden sm:inline"
              }`}
              href={link.href}
              key={link.href}
            >
              {link.label}
            </a>
          ))}
        </div>
      </nav>
    </header>
  );
}
