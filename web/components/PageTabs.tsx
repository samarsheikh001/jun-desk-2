import type { ReactNode } from "react";
import { navigate } from "../lib/router.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";

// A page with tabs in its header (Widget: Look / Install, Agent: Files / Settings). Each tab has its
// own URL, so links, reloads and the back button land on it; switching tabs replaces the entry, like
// the settings dialog's sections. Every panel stays mounted, so unsaved edits survive a switch.

export interface PageTab {
  value: string;
  label: string;
  path: string;
  content: ReactNode;
}

export function PageTabs({ title, tabs, value, className }: { title: string; tabs: PageTab[]; value: string; className?: string }) {
  return (
    <Tabs value={value} onValueChange={(v) => { const tab = tabs.find((t) => t.value === v); if (tab) navigate(tab.path, { replace: true }); }} className={`page-tabs${className ? ` ${className}` : ""}`}>
      <div className="page-tabs-head">
        <h1>{title}</h1>
        <TabsList className="kb-tabs page-tabs-list">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} keepMounted className="page-tabs-panel">{t.content}</TabsContent>
      ))}
    </Tabs>
  );
}
