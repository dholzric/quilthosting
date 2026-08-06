import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  RefreshControl,
  Alert,
  TextInput,
} from "react-native";
import { useFocusEffect, router } from "expo-router";
import { api, getSession, setSession } from "../lib/api";

export default function MemberHome() {
  const [me, setMe] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [tokenPaste, setTokenPaste] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const s = await getSession();
    if (!s?.slug) {
      setErr("No guild selected");
      return;
    }
    if (!s.token) {
      setErr("Paste a portal session token (from web magic-link hand-off) to continue.");
      return;
    }
    try {
      const data = await api(`/api/portal/${s.slug}/me`);
      setMe(data);
      const ev = await api(`/api/portal/${s.slug}/events`).catch(() => ({ events: [] }));
      setEvents(ev.events || ev || []);
      setErr("");
    } catch (e: any) {
      setErr(e.message || "Failed to load");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function saveToken() {
    const s = await getSession();
    if (!s || !tokenPaste.trim()) return;
    await setSession({ ...s, token: tokenPaste.trim() });
    setTokenPaste("");
    load();
  }

  async function logout() {
    await setSession(null);
    router.replace("/");
  }

  return (
    <ScrollView
      style={styles.wrap}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      {err ? (
        <View style={styles.card}>
          <Text style={styles.err}>{err}</Text>
          <Text style={styles.label}>Session token</Text>
          <TextInput
            style={styles.input}
            value={tokenPaste}
            onChangeText={setTokenPaste}
            autoCapitalize="none"
            placeholder="JWT from /auth/verify hand-off"
          />
          <Pressable style={styles.btn} onPress={saveToken}>
            <Text style={styles.btnText}>Save token</Text>
          </Pressable>
        </View>
      ) : null}

      {me?.member ? (
        <View style={styles.card}>
          <Text style={styles.h2}>
            {me.member.first_name} {me.member.last_name}
          </Text>
          <Text style={styles.muted}>{me.member.email}</Text>
          <Text style={styles.badge}>{me.member.status}</Text>
          {me.membership ? (
            <Text style={styles.muted}>
              {me.membership.level_name}
              {me.membership.end_date
                ? ` · ends ${new Date(me.membership.end_date).toLocaleDateString()}`
                : ""}
            </Text>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.section}>Upcoming events</Text>
      {(Array.isArray(events) ? events : []).map((e: any) => (
        <View key={e.id} style={styles.card}>
          <Text style={styles.h3}>{e.title}</Text>
          <Text style={styles.muted}>
            {e.start_at ? new Date(e.start_at).toLocaleString() : ""}
          </Text>
        </View>
      ))}
      {!events?.length && !err ? (
        <Text style={styles.muted}>No upcoming events</Text>
      ) : null}

      <Pressable style={[styles.btn, styles.secondary]} onPress={logout}>
        <Text style={styles.btnText}>Sign out</Text>
      </Pressable>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 16 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#e7dfd2",
  },
  h2: { fontSize: 20, fontWeight: "700" },
  h3: { fontSize: 16, fontWeight: "600" },
  muted: { color: "#8a847a", marginTop: 4 },
  badge: {
    alignSelf: "flex-start",
    marginTop: 8,
    backgroundColor: "#e3f2e6",
    color: "#2e7d43",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
    fontWeight: "600",
  },
  section: { fontSize: 14, fontWeight: "700", marginVertical: 8, color: "#57534b" },
  err: { color: "#b3261e", marginBottom: 8 },
  label: { fontSize: 12, color: "#57534b", marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: "#e7dfd2",
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  btn: {
    backgroundColor: "#b5501f",
    padding: 12,
    borderRadius: 10,
    alignItems: "center",
    marginTop: 8,
  },
  secondary: { backgroundColor: "#8a847a" },
  btnText: { color: "#fff", fontWeight: "700" },
});
