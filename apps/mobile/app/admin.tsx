import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  RefreshControl,
  Alert,
} from "react-native";
import { useFocusEffect, router } from "expo-router";
import { api, getSession, setSession } from "../lib/api";

export default function AdminHome() {
  const [stats, setStats] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [tenantId, setTenantId] = useState("");

  const load = useCallback(async () => {
    const s = await getSession();
    if (!s?.token || !s.tenantId) {
      setErr("Not signed in as admin");
      return;
    }
    setTenantId(s.tenantId);
    try {
      const st = await api(`/api/tenants/${s.tenantId}/stats`);
      setStats(st);
      const ev = await api(`/api/tenants/${s.tenantId}/events?upcoming=1`);
      setEvents(Array.isArray(ev) ? ev : ev.events || []);
      setErr("");
    } catch (e: any) {
      setErr(e.message || "Load failed");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

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
      {err ? <Text style={styles.err}>{err}</Text> : null}

      {stats?.members ? (
        <View style={styles.row}>
          <View style={styles.tile}>
            <Text style={styles.tileL}>Active</Text>
            <Text style={styles.tileV}>{stats.members.active}</Text>
          </View>
          <View style={styles.tile}>
            <Text style={styles.tileL}>Total</Text>
            <Text style={styles.tileV}>{stats.members.total}</Text>
          </View>
          <View style={styles.tile}>
            <Text style={styles.tileL}>Renew 30d</Text>
            <Text style={styles.tileV}>{stats.renewals_due_30d}</Text>
          </View>
        </View>
      ) : null}

      <Pressable
        style={styles.btn}
        onPress={() => router.push({ pathname: "/checkin", params: { tenantId } })}
      >
        <Text style={styles.btnText}>Event check-in</Text>
      </Pressable>

      <Text style={styles.section}>Upcoming events</Text>
      {events.map((e) => (
        <Pressable
          key={e.id}
          style={styles.card}
          onPress={() =>
            router.push({
              pathname: "/checkin",
              params: { tenantId, eventId: e.id, title: e.title },
            })
          }
        >
          <Text style={styles.h3}>{e.title}</Text>
          <Text style={styles.muted}>
            {e.start_at ? new Date(e.start_at).toLocaleString() : ""} · tap to check in
          </Text>
        </Pressable>
      ))}

      <Pressable style={[styles.btn, styles.secondary]} onPress={logout}>
        <Text style={styles.btnText}>Sign out</Text>
      </Pressable>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 16 },
  row: { flexDirection: "row", gap: 8, marginBottom: 12 },
  tile: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e7dfd2",
  },
  tileL: { fontSize: 11, color: "#8a847a", textTransform: "uppercase" },
  tileV: { fontSize: 22, fontWeight: "700", marginTop: 4 },
  section: { fontWeight: "700", color: "#57534b", marginVertical: 10 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e7dfd2",
  },
  h3: { fontSize: 16, fontWeight: "600" },
  muted: { color: "#8a847a", marginTop: 4, fontSize: 13 },
  err: { color: "#b3261e", marginBottom: 8 },
  btn: {
    backgroundColor: "#b5501f",
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
    marginBottom: 8,
  },
  secondary: { backgroundColor: "#8a847a", marginTop: 16 },
  btnText: { color: "#fff", fontWeight: "700" },
});
