import { FormEvent, useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { api, download, setAccessToken, type ApiUser } from "./api";

type Session = { user: ApiUser | null; ready: boolean };

export function App() {
  const [session, setSession] = useState<Session>({ user: null, ready: false });
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    api<{ user: ApiUser }>("/api/auth/me")
      .then((body) => setSession({ user: body.user, ready: true }))
      .catch(() => setSession({ user: null, ready: true }));
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (!session.ready) return <p className="main">Loading Curry Partner…</p>;
  return (
    <>
      {offline ? <div className="banner bad">You are offline. Changes will not be saved until the connection returns.</div> : null}
      <Routes>
        <Route path="/login" element={session.user ? <Navigate to={session.user.mustChangePassword ? "/password" : "/"} replace /> : <Login onUser={(user) => setSession({ user, ready: true })} />} />
        <Route path="/password" element={session.user ? <Password onUser={(user) => setSession({ user, ready: true })} /> : <Navigate to="/login" replace />} />
        <Route element={session.user ? (session.user.mustChangePassword ? <Navigate to="/password" replace /> : <Shell user={session.user} onLogout={() => setSession({ user: null, ready: true })} />) : <Navigate to="/login" replace />}>
          <Route index element={<Today />} />
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="homemakers" element={<Homemakers />} />
          <Route path="menus" element={<Menus />} />
          <Route path="floor" element={<Floor />} />
          <Route path="stock" element={<Stock />} />
          <Route path="payouts" element={<Payouts />} />
          <Route path="reports" element={<Reports />} />
          <Route path="settings" element={<Settings />} />
          <Route path="audit" element={<Audit />} />
        </Route>
      </Routes>
    </>
  );
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="30" fill="#e2a31b" />
      <path d="M16 38c6 8 26 8 32 0" fill="none" stroke="#24170f" strokeWidth="3" />
      <path d="M20 34c2-10 22-10 24 0" fill="#fffaf3" stroke="#24170f" strokeWidth="3" />
      <path d="M32 16c2 6-2 8 0 14" fill="none" stroke="#234c3a" strokeWidth="3" />
    </svg>
  );
}

function Login({ onUser }: { onUser: (user: ApiUser) => void }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const body = await api<{ accessToken: string; user: ApiUser }>("/api/auth/login", {
        method: "POST",
        body: { phone: String(form.get("phone")), password: String(form.get("password")), client: "web" },
      });
      setAccessToken(body.accessToken);
      onUser(body.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="login-screen">
      <section className="login-story">
        <div>
          <Mark />
          <p className="eyebrow">Curry Partner</p>
          <h1>Home food, sent to the stall.</h1>
          <p className="tagline">It’s not homely food. It’s home food.</p>
        </div>
        <p>Admins publish the menu, review cooks, and record collection, inspection, stock, and payouts.</p>
      </section>
      <section className="login-panel">
        <form className="card login-card stack" onSubmit={submit}>
          <h2>Admin sign in</h2>
          <p className="muted">Use the phone number issued to the owner or an administrator.</p>
          {error ? <div className="banner bad">{error}</div> : null}
          <label>Phone<input name="phone" autoComplete="username" required defaultValue="+919800000001" /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
          <button className="btn" disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
          {import.meta.env.VITE_HOME_URL ? <p className="muted"><a href={import.meta.env.VITE_HOME_URL}>Open the homemaker app</a></p> : null}
          {import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO === "true" ? <p className="muted">Demo only: +919800000001 / DemoAdmin-2026. These are fixture passwords, not production credentials.</p> : null}
        </form>
      </section>
    </div>
  );
}

function Password({ onUser }: { onUser: (user: ApiUser) => void }) {
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const body = await api<{ accessToken: string; user: ApiUser }>("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: String(form.get("current")), newPassword: String(form.get("next")) },
      });
      setAccessToken(body.accessToken);
      onUser(body.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the password.");
    }
  }
  return (
    <div className="login-panel">
      <form className="card login-card stack" onSubmit={submit}>
        <h2>Set a new password</h2>
        <p className="muted">The temporary password stops working for daily work until this is done.</p>
        {error ? <div className="banner bad">{error}</div> : null}
        <label>Current password<input name="current" type="password" required /></label>
        <label>New password<input name="next" type="password" required minLength={10} /></label>
        <button className="btn">Save password</button>
      </form>
    </div>
  );
}

function Shell({ user, onLogout }: { user: ApiUser; onLogout: () => void }) {
  const navigate = useNavigate();
  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setAccessToken(null);
    onLogout();
    navigate("/login");
  }
  const links = [
    ["/", "Today"],
    ["/onboarding", "Onboarding"],
    ["/homemakers", "Homemakers"],
    ["/menus", "Menus"],
    ["/floor", "Floor"],
    ["/stock", "Stock"],
    ["/payouts", "Payouts"],
    ["/reports", "Reports"],
    ["/settings", "Settings"],
    ["/audit", "Audit"],
  ] as const;
  return (
    <div className="shell">
      <aside className="nav">
        <div className="brand"><Mark /><div><strong>Curry Partner</strong><span>Admin</span></div></div>
        {links.map(([to, label]) => <NavLink key={to} to={to} end={to === "/"}>{label}</NavLink>)}
        <button className="btn secondary" onClick={logout} style={{ marginTop: 16 }}>Sign out {user.name.split(" ")[0]}</button>
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<T>(path)
      .then((body) => { if (!cancelled) { setData(body); setError(""); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, tick]);
  return { data, error, loading, reload: () => setTick((value) => value + 1) };
}

function Today() {
  const { data, error, loading, reload } = useLoad<{
    date: string; pendingOnboarding: number; openInspections: number; unpaidAmount: string; demoDataPresent: boolean;
    commitmentsByStatus: Record<string, number>;
    commitments: Commitment[];
  }>("/api/admin/dashboard");
  if (loading) return <p>Loading today’s floor…</p>;
  if (error) return <div className="banner bad">{error} <button className="btn secondary" onClick={reload}>Retry</button></div>;
  if (!data) return null;
  const counts = Object.values(data.commitmentsByStatus).reduce((sum, value) => sum + value, 0);
  return (
    <>
      <header className="topbar"><div><p className="eyebrow">Service day</p><h2>{data.date}</h2></div></header>
      {data.demoDataPresent ? <div className="banner">Demo fixtures are loaded. Names prefixed with DEMO are not production records.</div> : null}
      <div className="grid">
        <article className="card stat"><span>Commitments</span><b>{counts}</b></article>
        <article className="card stat"><span>Onboarding queue</span><b>{data.pendingOnboarding}</b></article>
        <article className="card stat"><span>Open inspections</span><b>{data.openInspections}</b></article>
        <article className="card stat"><span>Unpaid wallet</span><b>₹{data.unpaidAmount}</b></article>
      </div>
      <section className="card section">
        {data.commitments.length === 0 ? <p>No commitments for this date yet.</p> : <CommitmentTable rows={data.commitments} />}
      </section>
    </>
  );
}

type Commitment = {
  id: string;
  serviceDate: string;
  itemName: string;
  requestedQuantityKg: string;
  status: string;
  ratePerKg: string;
  preparationInstructions: string;
  homemaker?: { name: string; phone: string; addressLine: string; serviceArea: string };
  collection: { status: string; staffName: string | null; collectedAt: string | null; notes: string | null } | null;
  inspection: { id: string; result: string; acceptedQuantityKg: string; weightKg: string } | null;
};

function CommitmentTable({ rows }: { rows: Commitment[] }) {
  return (
    <table>
      <thead><tr><th>Cook</th><th>Dish</th><th>Kg</th><th>Status</th><th>Pickup</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{row.homemaker?.name}<br /><span className="muted">{row.homemaker?.addressLine}</span></td>
            <td>{row.itemName}</td>
            <td>{row.requestedQuantityKg}</td>
            <td><span className="pill">{row.status.replaceAll("_", " ")}</span></td>
            <td>{row.collection?.status ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Onboarding() {
  const { data, error, loading, reload } = useLoad<{ requests: Array<{ id: string; name: string; phone: string; addressLine: string; serviceArea: string; foodPreparationDetails: string; status: string; referenceCode: string }> }>("/api/admin/onboarding");
  const [message, setMessage] = useState("");
  const [secret, setSecret] = useState("");
  async function review(id: string, action: "approve" | "reject" | "more-info") {
    setMessage("");
    setSecret("");
    try {
      if (action === "approve") {
        const body = await api<{ temporaryPassword: string; phone: string; name: string }>(`/api/admin/onboarding/${id}/approve`, { method: "POST" });
        setSecret(`${body.name} · ${body.phone} · ${body.temporaryPassword}`);
        setMessage("Approved. Copy the temporary password now. It will not be shown again.");
      } else {
        const notes = window.prompt("Notes for the homemaker") ?? "";
        if (notes.trim().length < 8) { setMessage("Add at least 8 characters."); return; }
        await api(`/api/admin/onboarding/${id}/${action}`, { method: "POST", body: { adminNotes: notes } });
        setMessage(action === "reject" ? "Request rejected." : "More information requested.");
      }
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not update the request.");
    }
  }
  if (loading) return <p>Loading requests…</p>;
  if (error) return <div className="banner bad">{error}</div>;
  const requests = data?.requests ?? [];
  return (
    <>
      <header className="topbar"><div><h2>Onboarding</h2><p className="muted">A request does not grant access until you approve it.</p></div></header>
      {message ? <div className="banner">{message}</div> : null}
      {secret ? <p className="secret">{secret}</p> : null}
      {requests.length === 0 ? <div className="card section">No onboarding requests yet.</div> : requests.map((request) => (
        <article className="card section" key={request.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>{request.name}</h3><span className="pill">{request.status}</span>
          </div>
          <p>{request.phone} · {request.serviceArea}<br />{request.addressLine}</p>
          <p>{request.foodPreparationDetails}</p>
          <p className="muted">Reference {request.referenceCode}</p>
          {request.status === "SUBMITTED" || request.status === "MORE_INFO" ? (
            <div className="row">
              <button className="btn" onClick={() => review(request.id, "approve")}>Approve</button>
              <button className="btn secondary" onClick={() => review(request.id, "more-info")}>Ask for more</button>
              <button className="btn secondary" onClick={() => review(request.id, "reject")}>Reject</button>
            </div>
          ) : null}
        </article>
      ))}
    </>
  );
}

function Homemakers() {
  const { data, error, loading, reload } = useLoad<{ homemakers: Array<{ userId: string; name: string; phone: string; accountStatus: string; addressLine: string; serviceArea: string; mustChangePassword: boolean }> }>("/api/admin/homemakers");
  const [message, setMessage] = useState("");
  async function setStatus(userId: string, action: "suspend" | "reactivate") {
    try {
      await api(`/api/admin/homemakers/${userId}/${action}`, { method: "POST" });
      setMessage(action === "suspend" ? "Homemaker suspended and signed out." : "Homemaker reactivated.");
      reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not update the account.");
    }
  }
  if (loading) return <p>Loading homemakers…</p>;
  if (error) return <div className="banner bad">{error}</div>;
  const rows = data?.homemakers ?? [];
  return (
    <>
      <h2>Homemakers</h2>
      {message ? <div className="banner">{message}</div> : null}
      {rows.length === 0 ? <div className="card section">No approved homemakers yet.</div> : (
        <div className="card section">
          <table>
            <thead><tr><th>Name</th><th>Area</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId}>
                  <td>{row.name}<br /><span className="muted">{row.phone}<br />{row.addressLine}</span></td>
                  <td>{row.serviceArea}{row.mustChangePassword ? <><br /><span className="pill warn">Password reset due</span></> : null}</td>
                  <td><span className={`pill ${row.accountStatus === "ACTIVE" ? "good" : "bad"}`}>{row.accountStatus}</span></td>
                  <td>{row.accountStatus === "ACTIVE"
                    ? <button className="btn secondary" onClick={() => setStatus(row.userId, "suspend")}>Suspend</button>
                    : <button className="btn" onClick={() => setStatus(row.userId, "reactivate")}>Reactivate</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Menus() {
  const areas = useLoad<{ areas: Array<{ id: string; name: string }> }>("/api/admin/areas");
  const menus = useLoad<{ menus: Array<{ id: string; serviceDate: string; serviceArea: string; status: string; cutoffAt: string; items: Array<{ id: string; name: string; compensationPerKg: string }> }> }>("/api/admin/menus");
  const [message, setMessage] = useState("");
  async function createMenu(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/menus", { method: "POST", body: { serviceDate: form.get("serviceDate"), serviceAreaId: form.get("serviceAreaId"), notes: form.get("notes") || undefined } });
      setMessage("Draft menu created.");
      menus.reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not create the menu."); }
  }
  async function addItem(menuId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/admin/menus/${menuId}/items`, { method: "POST", body: {
        name: form.get("name"), description: form.get("description"), preparationInstructions: form.get("preparationInstructions"), compensationPerKg: form.get("compensationPerKg"),
      } });
      setMessage("Dish added.");
      menus.reload();
      event.currentTarget.reset();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not add the dish."); }
  }
  async function publish(menuId: string) {
    const overrideReason = window.prompt("Override reason, if the 5:00 PM deadline has passed. Leave blank otherwise.") ?? "";
    try {
      await api(`/api/admin/menus/${menuId}/publish`, { method: "POST", body: overrideReason.trim() ? { overrideReason } : {} });
      setMessage("Menu published. Homemakers in that area are notified.");
      menus.reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not publish."); }
  }
  if (menus.loading || areas.loading) return <p>Loading menus…</p>;
  if (menus.error || areas.error) return <div className="banner bad">{menus.error || areas.error}</div>;
  return (
    <>
      <h2>Menus</h2>
      {message ? <div className="banner">{message}</div> : null}
      <form className="card section stack" onSubmit={createMenu}>
        <h3>New draft</h3>
        <div className="row">
          <label>Service date<input type="date" name="serviceDate" required /></label>
          <label>Area<select name="serviceAreaId" required>{areas.data?.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
        </div>
        <label>Notes<textarea name="notes" /></label>
        <button className="btn">Create draft</button>
      </form>
      {(menus.data?.menus ?? []).length === 0 ? <div className="card section">No menus yet.</div> : menus.data?.menus.map((menu) => (
        <article className="card section" key={menu.id}>
          <div className="row" style={{ justifyContent: "space-between" }}><h3>{menu.serviceDate} · {menu.serviceArea}</h3><span className="pill">{menu.status}</span></div>
          <p className="muted">Commitment cutoff {new Date(menu.cutoffAt).toLocaleString()}</p>
          {menu.items.length === 0 ? <p>No dishes yet.</p> : <ul>{menu.items.map((item) => <li key={item.id}>{item.name} · ₹{item.compensationPerKg}/kg</li>)}</ul>}
          {menu.status === "DRAFT" ? (
            <>
              <form className="stack" onSubmit={(event) => addItem(menu.id, event)}>
                <div className="row">
                  <label>Dish<input name="name" required /></label>
                  <label>₹ / kg<input name="compensationPerKg" required placeholder="160.00" /></label>
                </div>
                <label>Description<input name="description" required /></label>
                <label>Preparation<input name="preparationInstructions" required /></label>
                <button className="btn secondary">Add dish</button>
              </form>
              <button className="btn" onClick={() => publish(menu.id)}>Publish</button>
            </>
          ) : null}
        </article>
      ))}
    </>
  );
}

function Floor() {
  const [date, setDate] = useState("");
  const path = date ? `/api/admin/commitments?date=${date}` : "/api/admin/commitments";
  const { data, error, loading, reload } = useLoad<{ commitments: Commitment[] }>(path);
  const [message, setMessage] = useState("");
  async function collect(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/admin/commitments/${id}/collection`, { method: "POST", body: {
        status: "COLLECTED",
        staffName: form.get("staffName"),
        collectedAt: new Date(String(form.get("collectedAt"))).toISOString(),
        notes: form.get("notes") || undefined,
      } });
      setMessage("Collection recorded.");
      reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not record collection."); }
  }
  async function inspect(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/admin/commitments/${id}/inspections`, { method: "POST", body: {
        weightKg: form.get("weightKg"),
        acceptedQuantityKg: form.get("acceptedQuantityKg"),
        waterContent: form.get("waterContent"),
        freshness: form.get("freshness"),
        hygiene: form.get("hygiene"),
        result: form.get("result"),
        notes: form.get("notes") || undefined,
        photoUrl: form.get("photoUrl") || undefined,
      } });
      setMessage("Inspection recorded. Payment waits unless the result is passed.");
      reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not record inspection."); }
  }
  async function resolve(id: string, outcome: "accepted" | "rejected") {
    const reason = window.prompt("Resolution reason") ?? "";
    const acceptedQuantityKg = outcome === "accepted" ? window.prompt("Accepted kg") ?? "" : undefined;
    try {
      await api(`/api/admin/inspections/${id}/resolve`, { method: "POST", body: { outcome, reason, acceptedQuantityKg } });
      setMessage("Inspection resolved.");
      reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not resolve."); }
  }
  if (loading) return <p>Loading commitments…</p>;
  if (error) return <div className="banner bad">{error}</div>;
  const rows = data?.commitments ?? [];
  return (
    <>
      <header className="topbar">
        <div><h2>Floor</h2><p className="muted">Record manual collection and inspection. Failed items are not credited.</p></div>
        <label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      </header>
      {message ? <div className="banner">{message}</div> : null}
      {rows.length === 0 ? <div className="card section">No commitments match this view.</div> : rows.map((row) => (
        <article className="card section" key={row.id}>
          <h3>{row.itemName} · {row.requestedQuantityKg} kg</h3>
          <p>{row.homemaker?.name} · {row.homemaker?.phone}<br />{row.homemaker?.addressLine}</p>
          <p className="muted">{row.preparationInstructions}</p>
          <p><span className="pill">{row.status.replaceAll("_", " ")}</span> {row.inspection ? <span className="pill warn">{row.inspection.result}</span> : null}</p>
          {row.status === "READY_FOR_COLLECTION" ? (
            <form className="row" onSubmit={(event) => collect(row.id, event)}>
              <input name="staffName" placeholder="Staff name" required />
              <input name="collectedAt" type="datetime-local" required />
              <input name="notes" placeholder="Notes" />
              <button className="btn">Mark collected</button>
            </form>
          ) : null}
          {row.status === "COLLECTED" && !row.inspection ? (
            <form className="stack" onSubmit={(event) => inspect(row.id, event)}>
              <div className="row">
                <input name="weightKg" placeholder="Weight kg" required />
                <input name="acceptedQuantityKg" placeholder="Accepted kg" required />
                <select name="waterContent"><option>NORMAL</option><option>LOW</option><option>HIGH</option></select>
                <select name="freshness"><option>GOOD</option><option>ACCEPTABLE</option><option>POOR</option></select>
                <select name="hygiene"><option>PASS</option><option>FAIL</option></select>
                <select name="result"><option>PASSED</option><option>FAILED</option><option>DISPUTED</option></select>
              </div>
              <input name="notes" placeholder="Notes" />
              <input name="photoUrl" placeholder="Optional photo URL" />
              <button className="btn leaf">Save inspection</button>
            </form>
          ) : null}
          {row.inspection && (row.inspection.result === "FAILED" || row.inspection.result === "DISPUTED") ? (
            <div className="row">
              <button className="btn" onClick={() => resolve(row.inspection!.id, "accepted")}>Accept on review</button>
              <button className="btn secondary" onClick={() => resolve(row.inspection!.id, "rejected")}>Reject</button>
            </div>
          ) : null}
        </article>
      ))}
    </>
  );
}

function Stock() {
  const stalls = useLoad<{ stalls: Array<{ id: string; name: string }> }>("/api/admin/stalls");
  const stock = useLoad<{ lots: Array<{ id: string; itemName: string; serviceDate: string; stallName: string | null; availableKg: string; acceptedKg: string; soldKg: string; wasteKg: string; returnedKg: string; adjustmentKg: string }> }>("/api/admin/stock");
  const [message, setMessage] = useState("");
  async function move(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/stock/movements", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { lotId: form.get("lotId"), type: form.get("type"), quantityKg: form.get("quantityKg"), reason: form.get("reason"), stallId: form.get("stallId") || undefined },
      });
      setMessage("Stock movement recorded.");
      stock.reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not move stock."); }
  }
  if (stock.loading) return <p>Loading stock…</p>;
  if (stock.error) return <div className="banner bad">{stock.error}</div>;
  const lots = stock.data?.lots ?? [];
  return (
    <>
      <h2>Stock</h2>
      {message ? <div className="banner">{message}</div> : null}
      {lots.length === 0 ? <div className="card section">No accepted stock yet. Stock appears after an inspection is accepted.</div> : (
        <div className="card section">
          <table>
            <thead><tr><th>Dish</th><th>Stall</th><th>Accepted</th><th>Sold</th><th>Waste</th><th>Available</th></tr></thead>
            <tbody>{lots.map((lot) => <tr key={lot.id}><td>{lot.itemName}<br /><span className="muted">{lot.serviceDate}</span></td><td>{lot.stallName ?? "Unassigned"}</td><td>{lot.acceptedKg}</td><td>{lot.soldKg}</td><td>{lot.wasteKg}</td><td>{lot.availableKg}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <form className="card section stack" onSubmit={move}>
        <h3>Record movement</h3>
        <label>Lot<select name="lotId" required>{lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.itemName} · {lot.availableKg} kg</option>)}</select></label>
        <div className="row">
          <select name="type"><option>ALLOCATION</option><option>SALE</option><option>WASTE</option><option>RETURN</option><option>ADJUSTMENT</option></select>
          <input name="quantityKg" placeholder="kg" required />
          <select name="stallId"><option value="">Stall</option>{stalls.data?.stalls.map((stall) => <option key={stall.id} value={stall.id}>{stall.name}</option>)}</select>
        </div>
        <input name="reason" placeholder="Reason" required />
        <button className="btn">Save movement</button>
      </form>
    </>
  );
}

function mondayOf(date = new Date()) {
  const copy = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() - day + 1);
  return copy.toISOString().slice(0, 10);
}

function Payouts() {
  const { data, error, loading, reload } = useLoad<{ batches: Array<{ id: string; weekStart: string; weekEnd: string; status: string; reference: string | null; items: Array<{ id: string; name: string; amount: string; status: string; failureDetail: string | null }> }> }>("/api/admin/payouts");
  const [message, setMessage] = useState("");
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const weekStart = String(new FormData(event.currentTarget).get("weekStart"));
    try {
      await api("/api/admin/payouts/batches", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { weekStart } });
      setMessage("Payout batch drafted from unpaid accepted credits.");
      reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not create the batch."); }
  }
  async function act(path: string, body?: unknown) {
    try {
      await api(path, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body });
      reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not update the payout."); }
  }
  if (loading) return <p>Loading payouts…</p>;
  if (error) return <div className="banner bad">{error}</div>;
  return (
    <>
      <h2>Weekly payouts</h2>
      {message ? <div className="banner">{message}</div> : null}
      <form className="card section row" onSubmit={create}>
        <label>Week starting Monday<input type="date" name="weekStart" defaultValue={mondayOf()} required /></label>
        <button className="btn">Create batch</button>
      </form>
      {(data?.batches ?? []).length === 0 ? <div className="card section">No payout batches yet.</div> : data?.batches.map((batch) => (
        <article className="card section" key={batch.id}>
          <div className="row" style={{ justifyContent: "space-between" }}><h3>{batch.weekStart} – {batch.weekEnd}</h3><span className="pill">{batch.status}</span></div>
          <table>
            <thead><tr><th>Homemaker</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>{batch.items.map((item) => (
              <tr key={item.id}><td>{item.name}</td><td>₹{item.amount}</td><td>{item.status}{item.failureDetail ? ` · ${item.failureDetail}` : ""}</td>
                <td>{item.status !== "PAID" && item.status !== "FAILED" ? <button className="btn secondary" onClick={() => {
                  const failureDetail = window.prompt("Failure detail") ?? "";
                  if (failureDetail.trim().length >= 8) void act(`/api/admin/payouts/items/${item.id}/fail`, { failureDetail });
                }}>Mark failed</button> : null}</td></tr>
            ))}</tbody>
          </table>
          <div className="row">
            {batch.status === "DRAFT" ? <button className="btn secondary" onClick={() => act(`/api/admin/payouts/batches/${batch.id}/approve`)}>Approve</button> : null}
            {batch.status === "APPROVED" ? <button className="btn" onClick={() => {
              const reference = window.prompt("Payout reference") ?? "";
              if (reference.trim().length >= 4) void act(`/api/admin/payouts/batches/${batch.id}/mark-paid`, { reference });
            }}>Mark paid</button> : null}
            {batch.reference ? <span className="muted">Reference {batch.reference}</span> : null}
          </div>
        </article>
      ))}
    </>
  );
}

function Reports() {
  const [query, setQuery] = useState("from=2026-01-01&to=2026-12-31");
  const { data, error, loading } = useLoad<{ rows: Array<Record<string, string>> }>(`/api/admin/reports/operations?${query}`);
  const [message, setMessage] = useState("");
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const key of ["from", "to", "dish"]) {
      const value = String(form.get(key) ?? "");
      if (value) params.set(key, value);
    }
    setQuery(params.toString());
  }
  return (
    <>
      <h2>Reports</h2>
      <form className="card section row" onSubmit={apply}>
        <label>From<input type="date" name="from" defaultValue="2026-01-01" required /></label>
        <label>To<input type="date" name="to" defaultValue="2026-12-31" required /></label>
        <label>Dish<input name="dish" /></label>
        <button className="btn">Run</button>
        <button className="btn secondary" type="button" onClick={() => download(`/api/admin/reports/operations.csv?${query}`, "curry-partner-operations.csv").catch((err) => setMessage(err.message))}>Export CSV</button>
      </form>
      {message ? <div className="banner bad">{message}</div> : null}
      {loading ? <p>Running the report…</p> : error ? <div className="banner bad">{error}</div> : (
        <div className="card section">
          {(data?.rows.length ?? 0) === 0 ? <p>No rows in this range.</p> : (
            <table>
              <thead><tr>{Object.keys(data!.rows[0]).map((key) => <th key={key}>{key}</th>)}</tr></thead>
              <tbody>{data!.rows.map((row, index) => <tr key={index}>{Object.values(row).map((value, cell) => <td key={cell}>{value}</td>)}</tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}

function Settings() {
  const settings = useLoad<{ maxCurriesPerHomemakerPerDay: number; maxKgPerCurry: string; menuPublishCutoffLocal: string; commitmentCutoffLocal: string; timezone: string }>("/api/admin/settings");
  const areas = useLoad<{ areas: Array<{ id: string; name: string; code: string; active: boolean; stalls: Array<{ name: string }> }> }>("/api/admin/areas");
  const [message, setMessage] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/settings", { method: "PUT", body: {
        maxCurriesPerHomemakerPerDay: Number(form.get("maxCurries")),
        maxKgPerCurry: String(form.get("maxKg")),
        menuPublishCutoffLocal: String(form.get("publish")),
        commitmentCutoffLocal: String(form.get("cutoff")),
        timezone: String(form.get("timezone")),
      } });
      setMessage("Limits saved. Menus already published keep their cutoff.");
      settings.reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not save settings."); }
  }
  async function addArea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/areas", { method: "POST", body: { name: form.get("name"), code: form.get("code") } });
      areas.reload();
      event.currentTarget.reset();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not add the area."); }
  }
  async function addStall(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/stalls", { method: "POST", body: { name: form.get("name"), serviceAreaId: form.get("serviceAreaId"), addressLine: form.get("addressLine") } });
      setMessage("Stall added.");
      areas.reload();
    } catch (err) { setMessage(err instanceof Error ? err.message : "Could not add the stall."); }
  }
  if (settings.loading) return <p>Loading settings…</p>;
  if (settings.error || !settings.data) return <div className="banner bad">{settings.error || "Settings missing."}</div>;
  const current = settings.data;
  return (
    <>
      <h2>Settings</h2>
      {message ? <div className="banner">{message}</div> : null}
      <form className="card section stack" onSubmit={save}>
        <label>Curries per homemaker per day<input name="maxCurries" type="number" min={1} max={10} defaultValue={current.maxCurriesPerHomemakerPerDay} /></label>
        <label>Max kg per curry<input name="maxKg" defaultValue={current.maxKgPerCurry} /></label>
        <div className="row">
          <label>Publish cutoff<input name="publish" defaultValue={current.menuPublishCutoffLocal} /></label>
          <label>Commitment cutoff<input name="cutoff" defaultValue={current.commitmentCutoffLocal} /></label>
          <label>Timezone<input name="timezone" defaultValue={current.timezone} /></label>
        </div>
        <button className="btn">Save limits</button>
      </form>
      <div className="split">
        <form className="card section stack" onSubmit={addArea}>
          <h3>Service area</h3>
          <input name="name" placeholder="Name" required />
          <input name="code" placeholder="Code" required />
          <button className="btn secondary">Add area</button>
          <ul>{areas.data?.areas.map((area) => <li key={area.id}>{area.name} · {area.code}{area.active ? "" : " (inactive)"}</li>)}</ul>
        </form>
        <form className="card section stack" onSubmit={addStall}>
          <h3>Stall</h3>
          <input name="name" placeholder="Stall name" required />
          <select name="serviceAreaId" required>{areas.data?.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select>
          <input name="addressLine" placeholder="Address" required />
          <button className="btn secondary">Add stall</button>
        </form>
      </div>
    </>
  );
}

function Audit() {
  const { data, error, loading } = useLoad<{ logs: Array<{ id: string; action: string; entityType: string; actor: { name: string } | null; createdAt: string }> }>("/api/admin/audit");
  if (loading) return <p>Loading the audit log…</p>;
  if (error) return <div className="banner bad">{error}</div>;
  const logs = data?.logs ?? [];
  return (
    <>
      <h2>Audit</h2>
      {logs.length === 0 ? <div className="card section">No audit events yet.</div> : (
        <div className="card section">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th></tr></thead>
            <tbody>{logs.map((log) => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.actor?.name ?? "System"}</td><td>{log.action}</td><td>{log.entityType}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
