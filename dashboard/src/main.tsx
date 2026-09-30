import { StrictMode, useEffect, useState } from "react";
import { AdminPage } from "./AdminPage";
import { ArenaPage } from "./ArenaPage";
import { BunnyPage } from "./BunnyPage";
import { LabPage } from "./LabPage";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Setup } from "./Setup";
import "./styles.css";
import "./panels.css";
import { applyProfile, type Profile } from "./types";

/** Hash routes: #/ live dashboard, #/bunny/<slot> one bunny's profile, #/lab ranking + warren memory, #/admin owner panel, #/arena member sign-in and account. */
function Routes() {
  const read = () => location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] ?? "";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  if (route === "lab") return <LabPage />;
  if (route === "admin") return <AdminPage />;
  if (route === "arena") return <ArenaPage />;
  if (route === "bunny") return <BunnyPage />;
  return <App />;
}

async function boot() {
  let profile: Profile | null = null;
  try {
    const r = await fetch("/profile", { cache: "no-store" });
    if (r.ok) profile = (await r.json()) as Profile;
  } catch {
    /* engine not up yet: show the defaults, the feed reconnects on its own */
  }
  if (profile && !profile.setup) applyProfile(profile);
  createRoot(document.getElementById("root")!).render(<StrictMode>{profile?.setup ? <Setup /> : <Routes />}</StrictMode>);
}

void boot();
