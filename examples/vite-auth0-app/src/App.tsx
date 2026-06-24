import { useEffect, useState } from "react";
import { useAuth0 } from "@auth0/auth0-react";

interface Message {
  id: number;
  from: string;
  text: string;
}

type View = "dashboard" | "settings";

export function App() {
  const { isLoading, isAuthenticated, user, loginWithRedirect, logout } = useAuth0();
  const [view, setView] = useState<View>("dashboard");

  if (isLoading) return <p>Loading…</p>;

  if (!isAuthenticated) {
    return (
      <main style={wrap}>
        <h1>Sauce Fixture</h1>
        <p>You must log in to view the dashboard.</p>
        <button onClick={() => loginWithRedirect()}>Log in</button>
      </main>
    );
  }

  return (
    <main style={wrap}>
      <header style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ flex: 1 }}>Welcome, {user?.name ?? "user"}</h1>
        <nav style={{ display: "flex", gap: 8 }}>
          <a href="#dashboard" onClick={() => setView("dashboard")}>
            Dashboard
          </a>
          <a href="#settings" onClick={() => setView("settings")}>
            Settings
          </a>
        </nav>
        <button onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}>
          Log out
        </button>
      </header>
      {view === "dashboard" ? <Dashboard /> : <Settings />}
    </main>
  );
}

function Dashboard() {
  const { getAccessTokenSilently } = useAuth0();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getAccessTokenSilently().catch(() => "");
        const res = await fetch("/api/messages", {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setMessages((await res.json()) as Message[]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [getAccessTokenSilently]);

  if (error) return <p data-testid="error">Failed to load messages: {error}</p>;
  if (!messages) return <p>Loading messages…</p>;

  return (
    <section>
      <h2>Messages</h2>
      <ul data-testid="messages">
        {messages.map((m) => (
          <li key={m.id}>
            <strong>{m.from}:</strong> {m.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Settings() {
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    fetch("/api/profile")
      .then((r) => r.json())
      .then(setProfile)
      .catch(() => setProfile({ error: true }));
  }, []);
  return (
    <section>
      <h2>Settings</h2>
      <pre data-testid="profile">{JSON.stringify(profile, null, 2)}</pre>
    </section>
  );
}

const wrap: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 640,
  margin: "40px auto",
  padding: 16,
};
