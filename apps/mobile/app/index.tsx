import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { router } from "expo-router";
import {
  getSession,
  setSession,
  api,
  requestMagicLink,
  adminLogin,
  apiBase,
} from "../lib/api";

export default function Home() {
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [boot, setBoot] = useState(true);

  useEffect(() => {
    getSession().then((s) => {
      if (s?.mode === "admin" && s.token) router.replace("/admin");
      else if (s?.mode === "member" && s.token && s.slug) router.replace("/member");
      else setBoot(false);
    });
  }, []);

  async function memberGo() {
    if (!slug.trim() || !email.trim()) {
      Alert.alert("Enter guild slug and email");
      return;
    }
    setBusy(true);
    try {
      // Prefer magic link; for mobile we also try storing slug for after deep link
      await setSession({ token: "", slug: slug.trim().toLowerCase(), mode: "member" });
      try {
        await requestMagicLink(slug.trim().toLowerCase(), email.trim().toLowerCase());
        Alert.alert(
          "Check your email",
          "Open the magic link on this device. After the web hand-off, paste the session token if prompted, or sign in again from the portal deep link."
        );
      } catch {
        // Fallback: some deployments require site gate — document for user
        Alert.alert(
          "Sign-in",
          `If email fails, open ${apiBase()}/portal?slug=${slug} in Safari/Chrome after site access, then use the same account here once JWT is available via deep link quilthosting://auth?token=…`
        );
      }
      // Dev convenience: open member shell; me endpoint will 401 until token set
      router.push("/member");
    } finally {
      setBusy(false);
    }
  }

  async function adminGo() {
    if (!email.trim() || !password) {
      Alert.alert("Enter email and password");
      return;
    }
    setBusy(true);
    try {
      const r = await adminLogin(email.trim().toLowerCase(), password);
      const tenants = await api<{ tenants: Array<{ id: string; slug: string; name: string }> }>(
        "/api/tenants",
        { token: r.token }
      );
      const t = tenants.tenants?.[0];
      if (!t) {
        Alert.alert("No guilds on this account");
        return;
      }
      await setSession({
        token: r.token,
        slug: t.slug,
        tenantId: t.id,
        mode: "admin",
      });
      router.replace("/admin");
    } catch (e: any) {
      Alert.alert("Login failed", e.message || "Error");
    } finally {
      setBusy(false);
    }
  }

  if (boot) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#b5501f" />
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.brand}>✦ QuiltHosting</Text>
      <Text style={styles.sub}>Native member & admin apps for quilt guilds</Text>

      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, mode === "member" && styles.tabOn]}
          onPress={() => setMode("member")}
        >
          <Text style={mode === "member" ? styles.tabOnText : styles.tabText}>Member</Text>
        </Pressable>
        <Pressable
          style={[styles.tab, mode === "admin" && styles.tabOn]}
          onPress={() => setMode("admin")}
        >
          <Text style={mode === "admin" ? styles.tabOnText : styles.tabText}>Admin</Text>
        </Pressable>
      </View>

      {mode === "member" ? (
        <>
          <Text style={styles.label}>Guild slug</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            value={slug}
            onChangeText={setSlug}
            placeholder="prairie-star"
          />
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
          />
          <Pressable style={styles.btn} onPress={memberGo} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Continue</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.label}>Admin email</Text>
          <TextInput
            style={styles.input}
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
          <Pressable style={styles.btn} onPress={adminGo} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Sign in</Text>}
          </Pressable>
          <Text style={styles.hint}>
            Production uses Google sign-in on web; password works when enabled. Prefer Expo Google auth in a follow-up build.
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 24, paddingTop: 48 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  brand: { fontSize: 28, fontWeight: "700", color: "#221f1a" },
  sub: { color: "#8a847a", marginTop: 6, marginBottom: 24 },
  tabs: { flexDirection: "row", gap: 8, marginBottom: 20 },
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e7dfd2",
  },
  tabOn: { backgroundColor: "#b5501f", borderColor: "#b5501f" },
  tabText: { color: "#57534b", fontWeight: "600" },
  tabOnText: { color: "#fff", fontWeight: "600" },
  label: { fontSize: 13, color: "#57534b", marginBottom: 4, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#e7dfd2",
    borderRadius: 10,
    padding: 12,
    backgroundColor: "#fff",
    marginBottom: 4,
  },
  btn: {
    backgroundColor: "#b5501f",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 16,
  },
  btnText: { color: "#fff", fontWeight: "700" },
  hint: { fontSize: 12, color: "#8a847a", marginTop: 12, lineHeight: 18 },
});
