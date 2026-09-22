import { useEffect, useState, type ReactNode } from "react";
import { Button, Drawer } from "@mantine/core";
import { Inbox, Folder, Bot, Plug, Activity, Menu } from "lucide-react";
import { routeLink, type Destination } from "../navigation.ts";

const destinations = [
  { id: "queue", label: "Inbox", icon: Inbox },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "agents", label: "Agent desk", icon: Bot },
  { id: "connections", label: "Connections", icon: Plug },
  { id: "issues", label: "Diagnostics", icon: Activity },
] as const;

export function WorkspaceShell({ destination, actions, children }: { destination: Destination; actions: ReactNode; children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  useEffect(() => { const close = () => setOpened(false); window.addEventListener("hashchange", close); return () => window.removeEventListener("hashchange", close); }, []);
  useEffect(() => { document.title = `${destinations.find(d => d.id === destination)?.label} · DAVE`; }, [destination]);
  const navigation = <nav aria-label="Main">{destinations.map(({ id, label, icon: Icon }, index) => <a key={id} href={routeLink(id)} className={`workspace-nav-link${index === 3 ? " secondary-nav" : ""}`} aria-current={destination === id ? "page" : undefined} onClick={() => setOpened(false)}><Icon size={18} aria-hidden="true" />{label}</a>)}</nav>;
  return <div className="workspace-shell">
    <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
    <aside className="workspace-sidebar"><a className="workspace-brand" href="#queue">DAVE</a>{navigation}</aside>
    <div className="workspace-body">
      <header className="workspace-header"><span className="workspace-breadcrumb">Workspace <span>/</span> {destinations.find(item => item.id === destination)?.label}</span><div className="mobile-navigation"><Button variant="default" leftSection={<Menu size={18} aria-hidden="true" />} onClick={() => setOpened(true)} aria-expanded={opened}>Menu</Button><strong>DAVE</strong></div>{actions}</header>
      <main id="main-content" tabIndex={-1} className="workspace-content">{children}</main>
    </div>
    <Drawer opened={opened} onClose={() => setOpened(false)} title="DAVE navigation" size="xs">{navigation}</Drawer>
  </div>;
}
