import { CodeMark, NomiorMark } from "./marks";

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-5 py-12 md:flex-row md:items-center md:px-10">
        <p className="flex items-center gap-2.5 text-sm font-medium tracking-tight">
          <CodeMark className="text-fog-dim" size={22} />
          Nomior <span className="text-fog">Code</span>
        </p>
        <a
          className="group flex items-center gap-2.5 font-mono text-xs text-fog-dim transition-colors hover:text-cream md:ms-auto"
          href="https://nomior.com"
        >
          <NomiorMark className="text-fog-dim transition-colors group-hover:text-fog" size={20} />
          Fifth mark of the Nomior family
        </a>
        <p className="font-mono text-xs text-fog-dim">© 2026 Nomior</p>
      </div>
    </footer>
  );
}
