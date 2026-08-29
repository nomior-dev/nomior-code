/**
 * The Nomior Code mark, shared by every in-app brand lockup.
 *
 * Same geometry as the landing page's `CodeMark` (`apps/nomior-landing/
 * src/components/marks.tsx`) and the favicon: two opposing chevrons holding
 * the Nomior family's gold dot. Kept in the fork's own directory so the
 * upstream components that render it need a one-line import rather than an
 * inlined asset.
 *
 * @module nomior/BrandMark
 */
import type { SVGProps } from "react";

/** Gold of the Nomior family dot; the one literal colour in the mark. */
const NOMIOR_GOLD = "#E3B26B";

export function NomiorCodeMark({
  size = 20,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg aria-hidden height={size} viewBox="0 0 100 100" width={size} {...props}>
      <g fill="none" stroke="currentColor" strokeWidth={1.8}>
        <path d="M 38 26 L 16 50 L 38 74" />
        <path d="M 62 26 L 84 50 L 62 74" opacity={0.7} />
      </g>
      <circle cx={50} cy={50} fill={NOMIOR_GOLD} r={3.5} />
    </svg>
  );
}
