"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon, type IconName } from "./Icon";
const subscribeMobile = (callback: () => void) => { const media = window.matchMedia("(max-width: 720px)"); media.addEventListener("change", callback); return () => media.removeEventListener("change", callback); };
export function WorkspaceShell({ children, tenant, clients, mode }: { children: React.ReactNode; tenant?: { id: string; name: string }; clients: Array<{ id: string; name: string }>; mode: string }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const mobile = useSyncExternalStore(subscribeMobile, () => window.matchMedia("(max-width: 720px)").matches, () => false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeMenu = () => { setOpen(false); menuButton.current?.focus(); };
  useEffect(() => {
    if (!open || !mobile) return;
    closeButton.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); menuButton.current?.focus(); } };
    document.addEventListener("keydown", escape);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", escape); };
  }, [open, mobile]);
  const clientLinks: Array<[string, string, IconName]> = tenant ? [[`/t/${tenant.id}`, "Overview", "grid"], [`/t/${tenant.id}/calls`, "Calls", "phone"], [`/t/${tenant.id}/messages`, "Messages", "message"], [`/t/${tenant.id}/bookings`, "Appointments", "calendar"], [`/t/${tenant.id}/callbacks`, "Follow-ups", "clock"], [`/t/${tenant.id}/settings`, "Client setup", "settings"], [`/t/${tenant.id}/simulator`, "Test receptionist", "play"]] : [];
  const navLink = (href: string, label: string, icon: IconName) => <Link key={href} href={href} onClick={closeMenu} className={path === href || (href.endsWith("/calls") && path.startsWith(`${href}/`)) ? "active" : ""} aria-current={path === href ? "page" : undefined}><Icon name={icon} size={19}/><span>{label}</span>{path === href ? <span className="nav-dot"/> : null}</Link>;
  const current = path === "/admin" ? "Admin panel" : path === "/tenants/new" ? "New client" : clientLinks.find(([href]) => href === path)?.[1] ?? (tenant ? "Call details" : "Clients");
  return <div className="shell">
    {open ? <button className="nav-backdrop" aria-label="Close navigation" onClick={closeMenu}/> : null}
    <aside className={`side ${open ? "is-open" : ""}`} inert={mobile && !open} aria-label="Workspace navigation"><button ref={closeButton} className="icon-button mobile-close" aria-label="Close navigation menu" onClick={closeMenu}><Icon name="close"/></button>
      <Link className="brand-lockup" href="/tenants" onClick={closeMenu}><span className="brand-mark"><Icon name="ghost" size={22}/></span><span><strong>Dispatch Ghost<span className="brand-period">.</span></strong><small>RECEPTIONIST WORKSPACE</small></span></Link>
      <div className="workspace-label"><span className="workspace-avatar">DG</span><span><strong>Your agency</strong><small>Personal workspace</small></span><Icon name="check" size={15}/></div>
      <nav aria-label="Main navigation"><div className="section">Workspace</div>{navLink("/tenants", "All clients", "clients")}{navLink("/admin", "Admin panel", "settings")}
        {tenant ? <><div className="section">Client workspace</div><select className="client-switch" aria-label="Switch client" value={tenant.id} onChange={(e) => { router.push(`/t/${e.target.value}`); setOpen(false); }}>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select>{clientLinks.map(([href, label, icon]) => navLink(href, label, icon))}</> : null}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><Icon name="phone" size={18}/><strong>A better first hello.</strong><p>Voice and messaging, managed in one place.</p><Link href="/tenants/new" onClick={closeMenu}>Add a client <Icon name="arrow" size={15}/></Link></div><span className="sidebar-caption">Dispatch Ghost · Agency workspace</span></div>
    </aside>
    <div className="workspace-body" inert={mobile && open}><header className="topbar"><div className="row"><button ref={menuButton} className="icon-button mobile-menu" onClick={() => setOpen(true)} aria-label="Open navigation"><Icon name="menu"/></button><Link href="/tenants">Workspace</Link><Icon name="chevron" size={13}/><span>{tenant ? `${tenant.name} / ${current}` : current}</span></div><div className="row topbar-right">{mode === "mock" ? <span className="preview-label"><span/>Demo workspace</span> : <span className="preview-label">Agency workspace</span>}<span className="owner-avatar" title="Personal workspace">DG</span></div></header><main>{children}</main><footer className="workspace-footer">Dispatch Ghost Receptionist<span>Built for your agency.</span></footer></div>
  </div>;
}
