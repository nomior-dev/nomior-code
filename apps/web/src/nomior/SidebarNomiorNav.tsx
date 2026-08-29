/**
 * The Nomior surfaces as sidebar destinations.
 *
 * Sits under the search and project rows, above the thread list: these are
 * places you go, not threads you resume, so they stay put while the list below
 * scrolls. One row per entry in `NOMIOR_PAGES` — adding a surface there adds it
 * here, and to the breadcrumb and the command palette, with no second list to
 * keep in step.
 *
 * @module nomior/SidebarNomiorNav
 */
import { Link, useLocation } from "@tanstack/react-router";
import { memo } from "react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar";
import { NOMIOR_PAGES } from "./pages";

export const SidebarNomiorNav = memo(function SidebarNomiorNav() {
  const { pathname } = useLocation();

  return (
    <SidebarMenu aria-label="Nomior">
      {NOMIOR_PAGES.map((page) => {
        const Icon = page.icon;
        return (
          <SidebarMenuItem key={page.id}>
            <SidebarMenuButton
              isActive={pathname.startsWith(page.path)}
              render={<Link to={page.path} />}
              // Collapsed to icons the label is gone; the tooltip is the only
              // thing naming the destination.
              tooltip={page.label}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{page.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
});
