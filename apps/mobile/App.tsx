import { StatusBar } from "expo-status-bar";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:4000";

type User = { id: string; name: string; phone: string; role: string; mustChangePassword: boolean };
type Screen = "welcome" | "join" | "status" | "login" | "password" | "menus" | "commitments" | "wallet" | "alerts" | "account";

type Session = { accessToken: string; refreshToken: string; user: User };

async function saveSession(session: Session | null) {
  if (Platform.OS === "web") {
    if (session) sessionStorage.setItem("cp_session", JSON.stringify(session));
    else sessionStorage.removeItem("cp_session");
    return;
  }
  if (session) await SecureStore.setItemAsync("cp_session", JSON.stringify(session));
  else await SecureStore.deleteItemAsync("cp_session");
}

async function loadSession(): Promise<Session | null> {
  try {
    const raw = Platform.OS === "web" ? sessionStorage.getItem("cp_session") : await SecureStore.getItemAsync("cp_session");
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

async function request(path: string, options: { method?: string; body?: unknown; token?: string } = {}) {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        "x-client": "mobile",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new Error("You appear to be offline. The request was not sent.");
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? "The request failed.") as Error & { code?: string };
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    loadSession().then((saved) => {
      if (saved) {
        setSession(saved);
        setScreen(saved.user.mustChangePassword ? "password" : "menus");
      }
      setReady(true);
    });
  }, []);

  function open(next: Screen) {
    setError("");
    setScreen(next);
  }

  async function establish(next: Session) {
    await saveSession(next);
    setSession(next);
    setScreen(next.user.mustChangePassword ? "password" : "menus");
  }

  async function logout() {
    if (session) await request("/api/auth/logout", { method: "POST", token: session.accessToken }).catch(() => undefined);
    await saveSession(null);
    setSession(null);
    setScreen("welcome");
  }

  if (!ready) {
    return <SafeAreaView style={styles.center}><ActivityIndicator color="#b64022" /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {screen === "welcome" ? <Welcome open={open} /> : null}
        {screen === "join" ? <Join open={open} setError={setError} /> : null}
        {screen === "status" ? <Status open={open} setError={setError} /> : null}
        {screen === "login" ? <Login open={open} setError={setError} onSession={establish} /> : null}
        {screen === "password" && session ? <Password session={session} setError={setError} onSession={establish} /> : null}
        {session && !session.user.mustChangePassword && ["menus", "commitments", "wallet", "alerts", "account"].includes(screen) ? (
          <Home screen={screen} session={session} setError={setError} logout={logout} />
        ) : null}
      </ScrollView>
      {session && !session.user.mustChangePassword ? (
        <View style={styles.tabs}>
          {([
            ["menus", "Menus"],
            ["commitments", "Cook"],
            ["wallet", "Wallet"],
            ["alerts", "Alerts"],
            ["account", "Account"],
          ] as const).map(([tab, label]) => (
            <Pressable key={tab} onPress={() => open(tab)} style={styles.tab}>
              <Text style={screen === tab ? styles.tabOn : styles.tabOff}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function Welcome({ open }: { open: (screen: Screen) => void }) {
  return (
    <View>
      <Text style={styles.kicker}>CURRY PARTNER</Text>
      <Text style={styles.title}>It’s not homely food. It’s home food.</Text>
      <Text style={styles.copy}>Cook for your neighbourhood curry point. Access starts only after Curry Partner approves you.</Text>
      <Pressable style={styles.primary} onPress={() => open("login")}><Text style={styles.primaryText}>Sign in</Text></Pressable>
      <Pressable style={styles.secondary} onPress={() => open("join")}><Text style={styles.secondaryText}>Request to cook</Text></Pressable>
      <Pressable onPress={() => open("status")}><Text style={styles.link}>Check a request</Text></Pressable>
      {process.env.EXPO_PUBLIC_SHOW_DEMO === "true" ? <Text style={styles.copy}>Demo cook: +919800000002 / DemoHome-2026. First login: +919800000003 / DemoTemp-2026.</Text> : null}
    </View>
  );
}

function Join({ open, setError }: { open: (screen: Screen) => void; setError: (value: string) => void }) {
  const [areas, setAreas] = useState<Array<{ id: string; name: string }>>([]);
  const [areaId, setAreaId] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [details, setDetails] = useState("");
  useEffect(() => {
    request("/api/public/service-areas").then((body) => setAreas(body.areas)).catch((err) => setError(err.message));
  }, [setError]);
  async function submit() {
    setError("");
    try {
      const body = await request("/api/onboarding/requests", {
        method: "POST",
        body: { name, phone, addressLine: address, serviceAreaId: areaId || areas[0]?.id, foodPreparationDetails: details, agreementAcknowledged: true },
      });
      setCode(body.referenceCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit.");
    }
  }
  if (code) {
    return (
      <View>
        <Text style={styles.title}>Request received</Text>
        <Text style={styles.copy}>Save this reference code. It does not let you sign in.</Text>
        <Text style={styles.secret}>{code}</Text>
        <Pressable style={styles.secondary} onPress={() => open("welcome")}><Text style={styles.secondaryText}>Back</Text></Pressable>
      </View>
    );
  }
  return (
    <View>
      <Text style={styles.title}>Cook with us</Text>
      {areas.length === 0 ? <Text style={styles.copy}>No service areas are open yet.</Text> : areas.map((area) => (
        <Pressable key={area.id} onPress={() => setAreaId(area.id)} style={areaId === area.id ? styles.choiceOn : styles.choice}>
          <Text>{area.name}</Text>
        </Pressable>
      ))}
      <TextInput style={styles.input} placeholder="Name" value={name} onChangeText={setName} />
      <TextInput style={styles.input} placeholder="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <TextInput style={styles.input} placeholder="Address and pickup notes" value={address} onChangeText={setAddress} />
      <TextInput style={styles.input} placeholder="What do you cook, and from which kitchen?" value={details} onChangeText={setDetails} multiline />
      <Pressable onPress={() => setAgreed((value) => !value)}><Text style={styles.copy}>{agreed ? "☑" : "☐"} I agree to the homemaker terms. This request does not create an account.</Text></Pressable>
      <Pressable style={styles.primary} disabled={!agreed} onPress={submit}><Text style={styles.primaryText}>Submit request</Text></Pressable>
      <Pressable onPress={() => open("welcome")}><Text style={styles.link}>Back</Text></Pressable>
    </View>
  );
}

function Status({ open, setError }: { open: (screen: Screen) => void; setError: (value: string) => void }) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<{ status: string; adminNotes: string | null } | null>(null);
  async function check() {
    setError("");
    try {
      setResult(await request("/api/onboarding/status", { method: "POST", body: { referenceCode: code } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No request found.");
    }
  }
  return (
    <View>
      <Text style={styles.title}>Request status</Text>
      <TextInput style={styles.input} placeholder="Reference code" value={code} onChangeText={setCode} autoCapitalize="characters" />
      <Pressable style={styles.primary} onPress={check}><Text style={styles.primaryText}>Check</Text></Pressable>
      {result ? <Text style={styles.copy}>{result.status}{result.adminNotes ? `\n${result.adminNotes}` : ""}</Text> : null}
      <Pressable onPress={() => open("welcome")}><Text style={styles.link}>Back</Text></Pressable>
    </View>
  );
}

function Login({ open, setError, onSession }: { open: (screen: Screen) => void; setError: (value: string) => void; onSession: (session: Session) => Promise<void> }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  async function submit() {
    setError("");
    try {
      const body = await request("/api/auth/login", { method: "POST", body: { phone, password, client: "mobile" } });
      await onSession({ accessToken: body.accessToken, refreshToken: body.refreshToken, user: body.user });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    }
  }
  return (
    <View>
      <Text style={styles.title}>Sign in</Text>
      <Text style={styles.copy}>Only an approved homemaker can sign in.</Text>
      <TextInput style={styles.input} placeholder="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
      <Pressable style={styles.primary} onPress={submit}><Text style={styles.primaryText}>Continue</Text></Pressable>
      <Pressable onPress={() => open("welcome")}><Text style={styles.link}>Back</Text></Pressable>
    </View>
  );
}

function Password({ session, setError, onSession }: { session: Session; setError: (value: string) => void; onSession: (session: Session) => Promise<void> }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  async function submit() {
    setError("");
    try {
      const body = await request("/api/auth/change-password", {
        method: "POST",
        token: session.accessToken,
        body: { currentPassword: current, newPassword: next },
      });
      await onSession({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken ?? session.refreshToken,
        user: body.user,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password.");
    }
  }
  return (
    <View>
      <Text style={styles.title}>Choose your password</Text>
      <Text style={styles.copy}>The temporary password cannot be used for cooking until you replace it.</Text>
      <TextInput style={styles.input} placeholder="Temporary password" value={current} onChangeText={setCurrent} secureTextEntry />
      <TextInput style={styles.input} placeholder="New password" value={next} onChangeText={setNext} secureTextEntry />
      <Pressable style={styles.primary} onPress={submit}><Text style={styles.primaryText}>Save password</Text></Pressable>
    </View>
  );
}

function Home({ screen, session, setError, logout }: { screen: Screen; session: Session; setError: (value: string) => void; logout: () => Promise<void> }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const path = screen === "menus" ? "/api/homemaker/menus" : screen === "commitments" ? "/api/homemaker/commitments" : screen === "wallet" ? "/api/homemaker/wallet" : screen === "alerts" ? "/api/homemaker/notifications" : "/api/homemaker/me";
  async function load() {
    setLoading(true);
    try {
      setData(await request(path, { token: session.accessToken }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [path]);
  async function commit(menuItemId: string) {
    try {
      await request("/api/homemaker/commitments", { method: "POST", token: session.accessToken, body: { menuItemId, quantityKg: "1.000" } });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not commit."); }
  }
  async function advance(id: string, status: string) {
    try {
      await request(`/api/homemaker/commitments/${id}/status`, { method: "POST", token: session.accessToken, body: { status } });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not update status."); }
  }
  async function readAll() {
    await request("/api/homemaker/notifications/read-all", { method: "POST", token: session.accessToken });
    await load();
  }
  if (loading) return <ActivityIndicator color="#b64022" />;
  if (screen === "menus") {
    const menus = data?.menus ?? [];
    return (
      <View>
        <Text style={styles.title}>Menus</Text>
        <Text style={styles.copy}>Up to {data?.limits?.maxCurriesPerHomemakerPerDay} curries, {data?.limits?.maxKgPerCurry} kg each.</Text>
        {menus.length === 0 ? <Text style={styles.copy}>No open menus for your area.</Text> : menus.map((menu: any) => (
          <View key={menu.id} style={styles.card}>
            <Text style={styles.cardTitle}>{menu.serviceDate}</Text>
            <Text style={styles.copy}>{menu.open ? "Commitments are open." : "The cutoff has passed. You can still read the instructions."}</Text>
            {menu.items.map((item: any) => (
              <View key={item.id} style={styles.item}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                <Text>{item.description}</Text>
                <Text style={styles.copy}>{item.preparationInstructions}</Text>
                <Text>₹{item.compensationPerKg}/kg · max {item.maxKgPerHomemaker} kg</Text>
                {item.commitmentId ? <Text style={styles.good}>Committed {item.committedQuantityKg} kg · {item.commitmentStatus}</Text> : menu.open ? (
                  <Pressable style={styles.primary} onPress={() => commit(item.id)}><Text style={styles.primaryText}>Commit 1.000 kg</Text></Pressable>
                ) : null}
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  }
  if (screen === "commitments") {
    const rows = data?.commitments ?? [];
    return (
      <View>
        <Text style={styles.title}>My cooking</Text>
        {rows.length === 0 ? <Text style={styles.copy}>You have not committed to a dish yet.</Text> : rows.map((row: any) => (
          <View key={row.id} style={styles.card}>
            <Text style={styles.cardTitle}>{row.itemName}</Text>
            <Text>{row.serviceDate} · {row.requestedQuantityKg} kg · ₹{row.ratePerKg}/kg</Text>
            <Text style={styles.copy}>{row.preparationInstructions}</Text>
            <Text style={styles.good}>{String(row.status).replaceAll("_", " ")}</Text>
            {row.inspection ? <Text>Inspection {row.inspection.result}. Accepted {row.inspection.resolvedQuantityKg ?? row.inspection.acceptedQuantityKg} kg.</Text> : null}
            {(row.allowedTransitions ?? []).map((status: string) => (
              <Pressable key={status} style={styles.secondary} onPress={() => advance(row.id, status)}>
                <Text style={styles.secondaryText}>Mark {status.replaceAll("_", " ").toLowerCase()}</Text>
              </Pressable>
            ))}
          </View>
        ))}
      </View>
    );
  }
  if (screen === "wallet") {
    return (
      <View>
        <Text style={styles.title}>Wallet</Text>
        <Text style={styles.secret}>₹{data?.unpaidAmount ?? "0.00"} unpaid</Text>
        <Text style={styles.copy}>Earned ₹{data?.earnedAmount ?? "0.00"}. Credits use the quantity that was inspected and accepted.</Text>
        {(data?.entries ?? []).length === 0 ? <Text style={styles.copy}>No wallet entries yet.</Text> : data.entries.map((entry: any) => (
          <View key={entry.id} style={styles.card}>
            <Text style={styles.cardTitle}>{entry.itemName}</Text>
            <Text>{entry.serviceDate} · {entry.acceptedQuantityKg} kg · ₹{entry.ratePerKg}/kg</Text>
            <Text>₹{entry.amount} · {entry.status}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (screen === "alerts") {
    const notes = data?.notifications ?? [];
    return (
      <View>
        <Text style={styles.title}>Alerts</Text>
        <Pressable onPress={readAll}><Text style={styles.link}>Mark all read</Text></Pressable>
        {notes.length === 0 ? <Text style={styles.copy}>No alerts yet. Important updates stay here even if a phone notification is missed.</Text> : notes.map((note: any) => (
          <View key={note.id} style={styles.card}>
            <Text style={styles.cardTitle}>{note.title}</Text>
            <Text>{note.body}</Text>
            <Text style={styles.copy}>{note.readAt ? "Read" : "Unread"}</Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View>
      <Text style={styles.title}>{data?.user?.name}</Text>
      <Text style={styles.copy}>{data?.profile?.serviceArea}</Text>
      <Text>{data?.profile?.addressLine}</Text>
      <Text style={styles.copy}>{data?.profile?.foodPreparationDetails}</Text>
      <Pressable style={styles.secondary} onPress={logout}><Text style={styles.secondaryText}>Sign out</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#f4ecdf" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#f4ecdf" },
  content: { padding: 22, paddingBottom: 40 },
  kicker: { letterSpacing: 2, fontSize: 12, fontWeight: "700", color: "#6d5848" },
  title: { fontSize: 36, lineHeight: 40, fontWeight: "700", color: "#24170f", marginVertical: 8 },
  copy: { color: "#6d5848", fontSize: 16, marginBottom: 12 },
  primary: { backgroundColor: "#b64022", borderRadius: 999, paddingVertical: 14, paddingHorizontal: 18, marginTop: 8 },
  primaryText: { color: "white", textAlign: "center", fontWeight: "700" },
  secondary: { borderWidth: 1, borderColor: "#e4d3bf", borderRadius: 999, paddingVertical: 12, paddingHorizontal: 16, marginTop: 10 },
  secondaryText: { textAlign: "center", color: "#24170f", fontWeight: "700" },
  link: { marginTop: 16, color: "#8c2d16", fontWeight: "700" },
  input: { backgroundColor: "white", borderRadius: 14, padding: 14, marginTop: 10, borderWidth: 1, borderColor: "#e4d3bf" },
  error: { backgroundColor: "#fde8e6", color: "#9d2430", padding: 12, borderRadius: 12, marginBottom: 12 },
  secret: { fontSize: 22, fontWeight: "700", marginVertical: 12 },
  choice: { padding: 12, borderRadius: 12, backgroundColor: "white", marginBottom: 8 },
  choiceOn: { padding: 12, borderRadius: 12, backgroundColor: "#f3e2c8", marginBottom: 8 },
  card: { backgroundColor: "#fffaf3", borderRadius: 18, padding: 16, marginBottom: 12 },
  cardTitle: { fontSize: 20, fontWeight: "700", marginBottom: 4 },
  item: { marginTop: 12 },
  good: { color: "#1f7a4d", fontWeight: "700", marginTop: 6 },
  tabs: { flexDirection: "row", borderTopWidth: 1, borderTopColor: "#e4d3bf", backgroundColor: "#fffaf3" },
  tab: { flex: 1, paddingVertical: 12 },
  tabOn: { textAlign: "center", fontWeight: "700", color: "#b64022" },
  tabOff: { textAlign: "center", color: "#6d5848" },
});
