import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api, getSession } from "../lib/api";

export default function CheckIn() {
  const { tenantId, eventId: paramEventId, title } = useLocalSearchParams<{
    tenantId: string;
    eventId?: string;
    title?: string;
  }>();
  const [eventId, setEventId] = useState(paramEventId || "");
  const [events, setEvents] = useState<any[]>([]);
  const [regs, setRegs] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await getSession();
      const tid = tenantId || s?.tenantId;
      if (!tid || !s?.token) return;
      if (!eventId) {
        const ev = await api(`/api/tenants/${tid}/events?upcoming=1`);
        setEvents(Array.isArray(ev) ? ev : []);
      }
    })();
  }, [tenantId, eventId]);

  useEffect(() => {
    if (!eventId) return;
    loadRegs();
  }, [eventId]);

  async function loadRegs() {
    const s = await getSession();
    const tid = tenantId || s?.tenantId;
    if (!tid || !eventId) return;
    setBusy(true);
    try {
      const data = await api(
        `/api/tenants/${tid}/events/${eventId}/registrations?limit=200`
      );
      setRegs(data.registrations || data || []);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setBusy(false);
    }
  }

  async function checkIn(regId: string) {
    const s = await getSession();
    const tid = tenantId || s?.tenantId;
    if (!tid || !eventId) return;
    try {
      await api(`/api/tenants/${tid}/events/${eventId}/check-in`, {
        method: "POST",
        body: JSON.stringify({ registration_id: regId }),
      });
      loadRegs();
    } catch (e: any) {
      Alert.alert("Check-in failed", e.message);
    }
  }

  if (!eventId) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.h2}>Choose event</Text>
        {events.map((e) => (
          <Pressable key={e.id} style={styles.card} onPress={() => setEventId(e.id)}>
            <Text style={styles.h3}>{e.title}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  const filtered = regs.filter((r) => {
    if (!q.trim()) return true;
    const t = `${r.name || ""} ${r.email || ""} ${r.ticket_code || ""}`.toLowerCase();
    return t.includes(q.toLowerCase());
  });

  return (
    <View style={styles.wrap}>
      <Text style={styles.h2}>{title || "Check-in"}</Text>
      <TextInput
        style={styles.input}
        placeholder="Search name, email, ticket…"
        value={q}
        onChangeText={setQ}
        autoCapitalize="none"
      />
      {busy ? <ActivityIndicator color="#b5501f" /> : null}
      <FlatList
        data={filtered}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={{ flex: 1 }}>
              <Text style={styles.h3}>{item.name || item.email}</Text>
              <Text style={styles.muted}>
                {item.status} {item.ticket_code ? `· ${item.ticket_code}` : ""}
              </Text>
            </View>
            {item.status !== "checked_in" ? (
              <Pressable style={styles.btn} onPress={() => checkIn(item.id)}>
                <Text style={styles.btnText}>Check in</Text>
              </Pressable>
            ) : (
              <Text style={styles.ok}>✓</Text>
            )}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: 16 },
  h2: { fontSize: 20, fontWeight: "700", marginBottom: 10 },
  h3: { fontSize: 15, fontWeight: "600" },
  muted: { color: "#8a847a", fontSize: 12, marginTop: 2 },
  input: {
    borderWidth: 1,
    borderColor: "#e7dfd2",
    borderRadius: 10,
    padding: 12,
    backgroundColor: "#fff",
    marginBottom: 10,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#e7dfd2",
    gap: 8,
  },
  btn: {
    backgroundColor: "#b5501f",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  ok: { color: "#2e7d43", fontSize: 22, fontWeight: "700" },
});
