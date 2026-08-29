/**
 * The vendored calendar's tooltip, under the names it imports.
 *
 * Both are Base UI tooltips; only the popup's export name differs, so this is
 * a rename and not an adapter. It lives here so the vendored files stay a
 * verbatim copy of the registry — see `../VENDOR.md`.
 *
 * @module nomior/eventCalendar/ui/tooltip
 */
export {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipPopup as TooltipContent,
} from "../../../components/ui/tooltip";
