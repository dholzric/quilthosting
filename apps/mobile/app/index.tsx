import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
} from "react-native";
import { router } from "expo-router";
import { getSession, setSession, requestMagicLink, apiBase } from "../lib/api";

/**
 * Sign-in hands off to the web auth flow and returns through the app's URL
 * scheme:
 *
 *   app  →  browser: /api/auth/google?dest=app&slug=…
 *   web  →  app:     quilthosting://auth?token=<jwt>&slug=<slug>
 *
 * The same hand-off backs magic-link email sign-in, so members never need a
 * password on either platform.
 */
export default function Home() {
  const [slug, setSlug] = useState("");
  const [email, setEmail] = useState("");
  const [mode, setMode] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [boot, setBoot] = useState(true);
  const [notice, setNotice] = useState("");

  /** Store the session that arrived on a quilthosting://auth?token=… link. */
  const handleAuthUrl = useCallback(
    async (url: string | null) => {
      if (!url || !url.includes("auth")) return false;
      const token = url.match(/[?&]token=([^&]+)/)?.[1];
      if (!token) return false;
      const linkSlug = url.match(/[?&]slug=([^&]+)/)?.[1];
      const nextSlug = decodeURIComponent(linkSlug || slug || "").toLowerCase();
      const nextMode = nextSlug ? "member" : "admin";
      await setSession({
        token: decodeURIComponent(token),
        slug: nextSlug,
        mode: nextMode,
      });
      router.replace(nextMode === "member" ? "/member" : "/admin");
      return true;
    },
    [slug]
  );

  useEffect(() => {
    // Cold start: the app may have been opened by the auth link itself
    Linking.getInitialURL().then(async (url) => {
      if (await handleAuthUrl(url)) return;
      const s = await getSession();
      if (s?.mode === "admin" && s.token) router.replace("/admin");
      else if (s?.mode === "member" && s.token && s.slug) router.replace("/member");
      else setBoot(false);
    });
    // Warm start: link arrives while the app is already running
    const sub = Linking.addEventListener("url", (e) => handleAuthUrl(e.url));
    return () => sub.remove();
  }, [handleAuthUrl]);

  async function signInWithGoogle() {
    if (mode === "member" && !slug.trim()) {
      Alert.alert("Guild web address", "Enter your guild's web address first.");
      return;
    }
    const target =
      `${apiBase()}/api/auth/google?dest=app` +
      (mode === "member" ? `&slug=${encodeURIComponent(slug.trim().toLowerCase())}` : "");
    setNotice(
      "Finish signing in with Google in your browser — you'll come back here automatically."
    );
    try {
      await Linking.openURL(target);
    } catch {
      Alert.alert("Could not open browser", target);
    }
  }

  async function sendMagicLink() {
    if (!slug.trim() || !email.trim()) {
      Alert.alert("Guild and email", "Enter your guild's web address and your email.");
      return;
    }
    setBusy(true);
    try {
      await requestMagicLink(slug.trim().toLowerCase(), email.trim().toLowerCase());
      setNotice(
        "Check your email on this device and tap the sign-in link — it opens the app and signs you in."
      );
    } catch (e: any) {
      Alert.alert("Could not send link", e?.message || "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (boot) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color="#b5501f" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.brand}>✦ QuiltHosting</Text>
      <Text style={styles.tagline}>Member &amp; admin apps for quilt guilds</Text>

      <View style={styles.tabs}>
        <Pressable
          onPress={() => setMode("member")}
          style={[styles.tab, mode === "member" && styles.tabOn]}
        >
          <Text style={[styles.tabText, mode === "member" && styles.tabTextOn]}>Member</Text>
        </Pressable>
        <Pressable
          onPress={() => setMode("admin")}
          style={[styles.tab, mode === "admin" && styles.tabOn]}
        >
          <Text style={[styles.tabText, mode === "admin" && styles.tabTextOn]}>Admin</Text>
        </Pressable>
      </View>

      {mode === "member" && (
        <>
          <Text style={styles.label}>Guild web address</Text>
          <TextInput
            style={styles.input}
            placeholder="prairie-star"
            autoCapitalize="none"
            autoCorrect={false}
            value={slug}
            onChangeText={setSlug}
          />
        </>
      )}

      <Pressable style={styles.primary} onPress={signInWithGoogle}>
        <Text style={styles.primaryText}>Continue with Google</Text>
      </Pressable>

      {mode === "member" && (
        <>
          <Text style={styles.or}>or</Text>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Pressable style={styles.secondary} onPress={sendMagicLink} disabled={busy}>
            <Text style={styles.secondaryText}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </Text>
          </Pressable>
        </>
      )}

      {!!notice && <Text style={styles.notice}>{notice}</Text>}

      <Text style={styles.fine}>
        No password needed. Signing in opens your browser once, then returns to the app.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#faf7f2" },
  center: { alignItems: "center", justifyContent: "center" },
  content: { padding: 24, paddingTop: 40 },
  brand: { fontSize: 30, fontWeight: "700", color: "#221f1a" },
  tagline: { fontSize: 15, color: "#8a847a", marginTop: 6, marginBottom: 24 },
  tabs: { flexDirection: "row", gap: 10, marginBottom: 24 },
  tab: {
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#d6cbb8",
    backgroundColor: "#fff",
  },
  tabOn: { backgroundColor: "#b5501f", borderColor: "#b5501f" },
  tabText: { color: "#57534b", fontWeight: "600" },
  tabTextOn: { color: "#fff" },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: "#57534b",
    marginBottom: 6,
    marginTop: 10,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d6cbb8",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: "#fff",
    color: "#221f1a",
  },
  primary: {
    backgroundColor: "#b5501f",
    borderRadius: 8,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 22,
  },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  secondary: {
    borderWidth: 1,
    borderColor: "#d6cbb8",
    backgroundColor: "#fff",
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 14,
  },
  secondaryText: { color: "#57534b", fontWeight: "600", fontSize: 15 },
  or: { textAlign: "center", color: "#8a847a", marginTop: 18 },
  notice: {
    marginTop: 20,
    backgroundColor: "#f7e8de",
    color: "#7c3413",
    padding: 14,
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 20,
  },
  fine: { marginTop: 24, color: "#8a847a", fontSize: 12, lineHeight: 18 },
});
