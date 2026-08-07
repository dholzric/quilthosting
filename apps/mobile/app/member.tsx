import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Alert,
  Linking,
} from "react-native";
import { router } from "expo-router";
import { api, getSession, setSession, apiBase } from "../lib/api";

type Tab = "home" | "events" | "invoices" | "docs" | "directory" | "profile";

const TABS: { key: Tab; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "events", label: "Events" },
  { key: "invoices", label: "Invoices" },
  { key: "docs", label: "Documents" },
  { key: "directory", label: "Directory" },
  { key: "profile", label: "Profile" },
];

const money = (c?: number) => "$" + ((c || 0) / 100).toFixed(2);
const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
const dayTime = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";

export default function Member() {
  const [tab, setTab] = useState<Tab>("home");
  const [slug, setSlug] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [me, setMe] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [myRegs, setMyRegs] = useState<Record<string, any>>({});
  const [invoices, setInvoices] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [news, setNews] = useState<any[]>([]);
  const [directory, setDirectory] = useState<any[]>([]);
  const [form, setForm] = useState({ first_name: "", last_name: "", phone: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (s: string) => {
      const [meRes, evRes, invRes, fileRes, newsRes, dirRes] = await Promise.allSettled([
        api(`/api/portal/${s}/me`),
        api(`/api/portal/${s}/events`),
        api(`/api/portal/${s}/invoices`),
        api(`/api/portal/${s}/files`),
        api(`/api/portal/${s}/newsletters`),
        api(`/api/portal/${s}/directory`),
      ]);
      if (meRes.status === "fulfilled") {
        setMe(meRes.value);
        const m = meRes.value.member;
        if (m) {
          setForm({
            first_name: m.first_name || "",
            last_name: m.last_name || "",
            phone: m.phone || "",
          });
        }
      }
      if (evRes.status === "fulfilled") {
        setEvents(evRes.value.events || []);
        const map: Record<string, any> = {};
        (evRes.value.my_registrations || []).forEach((r: any) => (map[r.event_id] = r));
        setMyRegs(map);
      }
      if (invRes.status === "fulfilled") setInvoices(invRes.value.invoices || []);
      if (fileRes.status === "fulfilled")
        setFiles(Array.isArray(fileRes.value) ? fileRes.value : []);
      if (newsRes.status === "fulfilled")
        setNews(Array.isArray(newsRes.value) ? newsRes.value : []);
      if (dirRes.status === "fulfilled") setDirectory(dirRes.value.members || []);
    },
    []
  );

  useEffect(() => {
    getSession().then(async (s) => {
      if (!s?.token || !s.slug) {
        router.replace("/");
        return;
      }
      setSlug(s.slug);
      setToken(s.token);
      await load(s.slug);
      setLoading(false);
    });
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load(slug);
    setRefreshing(false);
  }

  async function signOut() {
    await setSession(null);
    router.replace("/");
  }

  async function renew() {
    try {
      const r = await api(`/api/portal/${slug}/renew`, { method: "POST", body: "{}" });
      if (r.checkout_url) Linking.openURL(r.checkout_url);
      else {
        Alert.alert("Renewed", "Your membership has been renewed.");
        onRefresh();
      }
    } catch (e: any) {
      Alert.alert("Could not renew", e?.message || "Please try again.");
    }
  }

  async function register(ev: any) {
    const email = me?.member?.email || me?.user?.email;
    if (!email) return;
    try {
      const r = await api(`/public/${slug}/events/${ev.id}/register`, {
        method: "POST",
        body: JSON.stringify({
          email,
          name: [me?.member?.first_name, me?.member?.last_name].filter(Boolean).join(" "),
        }),
      });
      if (r.checkout_url) Linking.openURL(r.checkout_url);
      else {
        Alert.alert("You're registered", r.ticket_code ? `Ticket ${r.ticket_code}` : "See you there!");
        onRefresh();
      }
    } catch (e: any) {
      Alert.alert("Could not register", e?.message || "Please try again.");
    }
  }

  async function saveProfile() {
    setSaving(true);
    try {
      await api(`/api/portal/${slug}/profile`, {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      Alert.alert("Saved", "Your profile has been updated.");
      onRefresh();
    } catch (e: any) {
      Alert.alert("Could not save", e?.message || "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <View style={[s.screen, s.center]}>
        <ActivityIndicator color="#b5501f" />
      </View>
    );
  }

  const member = me?.member;
  const membership = me?.membership;

  return (
    <View style={s.screen}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabBar}>
        {TABS.map((t) => (
          <Pressable key={t.key} onPress={() => setTab(t.key)} style={s.tabBtn}>
            <Text style={[s.tabLabel, tab === t.key && s.tabLabelOn]}>{t.label}</Text>
            {tab === t.key && <View style={s.tabUnderline} />}
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView
        contentContainerStyle={s.body}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {tab === "home" && (
          <>
            <View style={s.card}>
              <Text style={s.h1}>
                {[member?.first_name, member?.last_name].filter(Boolean).join(" ") || "Member"}
              </Text>
              <Text style={s.muted}>{member?.email}</Text>
              <View style={s.badgeRow}>
                <Text style={[s.badge, member?.status === "active" ? s.badgeOk : s.badgeWarn]}>
                  {member?.status || "unknown"}
                </Text>
              </View>
              {membership && (
                <Text style={s.muted}>
                  {membership.level_name} · ends {day(membership.end_date)}
                </Text>
              )}
              <Pressable style={s.primary} onPress={renew}>
                <Text style={s.primaryText}>Renew membership</Text>
              </Pressable>
            </View>

            <Text style={s.h2}>Next up</Text>
            {events.slice(0, 3).map((ev) => (
              <View key={ev.id} style={s.card}>
                <Text style={s.itemTitle}>{ev.title}</Text>
                <Text style={s.muted}>{dayTime(ev.start_at)}</Text>
                {!!ev.location && <Text style={s.muted}>{ev.location}</Text>}
              </View>
            ))}
            {!events.length && <Text style={s.muted}>No upcoming events.</Text>}
          </>
        )}

        {tab === "events" && (
          <>
            {events.map((ev) => {
              const reg = myRegs[ev.id];
              return (
                <View key={ev.id} style={s.card}>
                  <Text style={s.itemTitle}>{ev.title}</Text>
                  <Text style={s.muted}>{dayTime(ev.start_at)}</Text>
                  {!!ev.location && <Text style={s.muted}>{ev.location}</Text>}
                  {!!ev.description && <Text style={s.body2}>{ev.description}</Text>}
                  <Text style={s.muted}>
                    Members {ev.member_price_cents ? money(ev.member_price_cents) : "free"}
                  </Text>
                  {reg ? (
                    <View style={s.badgeRow}>
                      <Text style={[s.badge, s.badgeOk]}>{reg.status}</Text>
                      {!!reg.ticket_code && <Text style={s.ticket}>{reg.ticket_code}</Text>}
                    </View>
                  ) : ev.registration_open ? (
                    <Pressable style={s.primary} onPress={() => register(ev)}>
                      <Text style={s.primaryText}>Register</Text>
                    </Pressable>
                  ) : (
                    <Text style={s.muted}>Registration closed</Text>
                  )}
                </View>
              );
            })}
            {!events.length && <Text style={s.muted}>No upcoming events.</Text>}
          </>
        )}

        {tab === "invoices" && (
          <>
            {invoices.map((inv) => (
              <View key={inv.id} style={s.card}>
                <View style={s.row}>
                  <Text style={s.itemTitle}>{money(inv.amount_cents)}</Text>
                  <Text style={[s.badge, inv.status === "succeeded" ? s.badgeOk : s.badgeWarn]}>
                    {inv.status}
                  </Text>
                </View>
                <Text style={s.muted}>{inv.description || inv.type}</Text>
                <Text style={s.muted}>{day(inv.created_at)}</Text>
              </View>
            ))}
            {!invoices.length && <Text style={s.muted}>No payments yet.</Text>}
          </>
        )}

        {tab === "docs" && (
          <>
            {!!news.length && <Text style={s.h2}>Newsletters</Text>}
            {news.map((n) => (
              <Pressable
                key={n.id}
                style={s.card}
                onPress={() =>
                  Linking.openURL(`${apiBase()}/portal?slug=${slug}`)
                }
              >
                <Text style={s.itemTitle}>{n.subject}</Text>
                <Text style={s.muted}>{day(n.created_at)}</Text>
              </Pressable>
            ))}

            {!!files.length && <Text style={s.h2}>Documents</Text>}
            {files.map((f) => (
              <Pressable
                key={f.id}
                style={s.card}
                onPress={() =>
                  Linking.openURL(
                    `${apiBase()}/api/portal/${slug}/files/${f.id}?token=${encodeURIComponent(token)}`
                  )
                }
              >
                <Text style={s.itemTitle}>{f.filename}</Text>
                <Text style={s.muted}>
                  {f.size ? (f.size / 1024).toFixed(0) + " KB · " : ""}
                  {day(f.created_at)}
                </Text>
              </Pressable>
            ))}
            {!news.length && !files.length && (
              <Text style={s.muted}>Nothing shared yet.</Text>
            )}
          </>
        )}

        {tab === "directory" && (
          <>
            {directory.map((m, i) => (
              <View key={i} style={s.card}>
                <Text style={s.itemTitle}>
                  {[m.first_name, m.last_name].filter(Boolean).join(" ") || "(name not shared)"}
                </Text>
                {!!m.joined_at && <Text style={s.muted}>Member since {day(m.joined_at)}</Text>}
              </View>
            ))}
            {!directory.length && <Text style={s.muted}>No members to show.</Text>}
          </>
        )}

        {tab === "profile" && (
          <View style={s.card}>
            <Text style={s.label}>First name</Text>
            <TextInput
              style={s.input}
              value={form.first_name}
              onChangeText={(v) => setForm({ ...form, first_name: v })}
            />
            <Text style={s.label}>Last name</Text>
            <TextInput
              style={s.input}
              value={form.last_name}
              onChangeText={(v) => setForm({ ...form, last_name: v })}
            />
            <Text style={s.label}>Phone</Text>
            <TextInput
              style={s.input}
              keyboardType="phone-pad"
              value={form.phone}
              onChangeText={(v) => setForm({ ...form, phone: v })}
            />
            <Text style={s.label}>Email</Text>
            <TextInput style={[s.input, s.inputOff]} value={member?.email || ""} editable={false} />
            <Pressable style={s.primary} onPress={saveProfile} disabled={saving}>
              <Text style={s.primaryText}>{saving ? "Saving…" : "Save profile"}</Text>
            </Pressable>
            <Pressable style={s.secondary} onPress={signOut}>
              <Text style={s.secondaryText}>Sign out</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#faf7f2" },
  center: { alignItems: "center", justifyContent: "center" },
  tabBar: {
    flexGrow: 0,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e7dfd2",
  },
  tabBtn: { paddingHorizontal: 16, paddingVertical: 14 },
  tabLabel: { color: "#8a847a", fontWeight: "600", fontSize: 14 },
  tabLabelOn: { color: "#b5501f" },
  tabUnderline: {
    height: 2,
    backgroundColor: "#b5501f",
    marginTop: 8,
    borderRadius: 2,
  },
  body: { padding: 16, paddingBottom: 48 },
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e7dfd2",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  h1: { fontSize: 22, fontWeight: "700", color: "#221f1a" },
  h2: { fontSize: 15, fontWeight: "700", color: "#57534b", marginTop: 8, marginBottom: 8 },
  itemTitle: { fontSize: 16, fontWeight: "700", color: "#221f1a" },
  body2: { color: "#57534b", marginTop: 6 },
  muted: { color: "#8a847a", marginTop: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 8 },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: "700",
    overflow: "hidden",
  },
  badgeOk: { backgroundColor: "#e3f2e6", color: "#2e7d43" },
  badgeWarn: { backgroundColor: "#f9eeda", color: "#a9640e" },
  ticket: { fontFamily: "monospace", color: "#57534b" },
  primary: {
    backgroundColor: "#b5501f",
    borderRadius: 8,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 12,
  },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  secondary: {
    borderWidth: 1,
    borderColor: "#d6cbb8",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 10,
  },
  secondaryText: { color: "#57534b", fontWeight: "600" },
  label: { fontSize: 13, fontWeight: "600", color: "#57534b", marginTop: 10, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: "#d6cbb8",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 16,
    backgroundColor: "#fff",
    color: "#221f1a",
  },
  inputOff: { backgroundColor: "#f4efe7", color: "#8a847a" },
});
