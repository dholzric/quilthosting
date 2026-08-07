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
} from "react-native";
import { router } from "expo-router";
import { api, getSession, setSession } from "../lib/api";

type Tab =
  | "dashboard"
  | "members"
  | "events"
  | "levels"
  | "payments"
  | "reports"
  | "team";

const TAB_LABELS: { key: Tab; label: string }[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "members", label: "Members" },
  { key: "events", label: "Events" },
  { key: "levels", label: "Levels" },
  { key: "payments", label: "Payments" },
  { key: "reports", label: "Reports" },
  { key: "team", label: "Team" },
];

const money = (c?: number) => "$" + ((c || 0) / 100).toFixed(2);
const day = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";
const dayTime = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";

/** Lists come back either as a bare array or a paginated envelope. */
function asList(v: any): any[] {
  if (Array.isArray(v)) return v;
  return v?.items || v?.members || v?.events || v?.results || [];
}

export default function Admin() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [guilds, setGuilds] = useState<any[]>([]);
  const [tenant, setTenant] = useState<any>(null);

  const [stats, setStats] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [levels, setLevels] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [annual, setAnnual] = useState<any>(null);
  const [team, setTeam] = useState<any[]>([]);
  const [query, setQuery] = useState("");

  const loadTenant = useCallback(async (t: any) => {
    const year = new Date().getFullYear();
    const [st, mem, ev, lv, pay, ann, tm] = await Promise.allSettled([
      api(`/api/tenants/${t.id}/stats`),
      api(`/api/tenants/${t.id}/members`),
      api(`/api/tenants/${t.id}/events?upcoming=1`),
      api(`/api/tenants/${t.id}/levels`),
      api(`/api/tenants/${t.id}/payments`),
      api(`/api/tenants/${t.id}/stats/annual?year=${year}`),
      api(`/api/tenants/${t.id}/team`),
    ]);
    if (st.status === "fulfilled") setStats(st.value);
    if (mem.status === "fulfilled") setMembers(asList(mem.value));
    if (ev.status === "fulfilled") setEvents(asList(ev.value));
    if (lv.status === "fulfilled") setLevels(asList(lv.value));
    if (pay.status === "fulfilled") setPayments(asList(pay.value));
    if (ann.status === "fulfilled") setAnnual(ann.value);
    if (tm.status === "fulfilled") setTeam(asList(tm.value));
  }, []);

  useEffect(() => {
    (async () => {
      const s = await getSession();
      if (!s?.token) {
        router.replace("/");
        return;
      }
      try {
        const list = (await api("/api/tenants")).tenants || [];
        setGuilds(list);
        if (list.length === 1) {
          setTenant(list[0]);
          await loadTenant(list[0]);
        }
      } catch {
        /* surfaced as an empty guild list */
      }
      setLoading(false);
    })();
  }, [loadTenant]);

  async function pickGuild(g: any) {
    setTenant(g);
    setLoading(true);
    await loadTenant(g);
    setLoading(false);
  }

  async function onRefresh() {
    if (!tenant) return;
    setRefreshing(true);
    await loadTenant(tenant);
    setRefreshing(false);
  }

  async function signOut() {
    await setSession(null);
    router.replace("/");
  }

  /** Same token serves both views — switching hats never requires a re-login. */
  async function switchToMember() {
    const sess = await getSession();
    await setSession({
      token: sess?.token || "",
      slug: tenant?.slug || sess?.slug || "",
      mode: "member",
    });
    router.replace("/member");
  }

  if (loading) {
    return (
      <View style={[s.screen, s.center]}>
        <ActivityIndicator color="#b5501f" />
      </View>
    );
  }

  // Guild picker — shown when the admin belongs to several guilds
  if (!tenant) {
    return (
      <ScrollView style={s.screen} contentContainerStyle={s.body}>
        <Text style={s.h1}>Your guilds</Text>
        {guilds.map((g) => (
          <Pressable key={g.id} style={s.card} onPress={() => pickGuild(g)}>
            <Text style={s.itemTitle}>{g.name}</Text>
            <Text style={s.muted}>{g.role || "admin"}</Text>
          </Pressable>
        ))}
        {!guilds.length && (
          <Text style={s.muted}>
            No guilds on this account. Sign in with the address that was invited.
          </Text>
        )}
        <Pressable style={s.secondary} onPress={signOut}>
          <Text style={s.secondaryText}>Sign out</Text>
        </Pressable>
      </ScrollView>
    );
  }

  const m = stats?.members;
  const filtered = query
    ? members.filter((x) =>
        [x.first_name, x.last_name, x.email]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase())
      )
    : members;

  return (
    <View style={s.screen}>
      <View style={s.topBar}>
        <Text style={s.topBarTitle} numberOfLines={1}>
          {tenant.name}
        </Text>
        <Pressable style={s.switchBtn} onPress={switchToMember}>
          <Text style={s.switchBtnText}>Member view →</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabBar}>
        {TAB_LABELS.map((t) => (
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
        <Text style={s.guildName}>{tenant.name}</Text>

        {tab === "dashboard" && (
          <>
            <View style={s.tiles}>
              <Tile label="Active members" value={m?.active ?? "—"} />
              <Tile label="New this month" value={m?.new_this_month ?? "—"} />
              <Tile label="Renewals due 30d" value={stats?.renewals_due_30d ?? "—"} />
              <Tile label="Upcoming events" value={stats?.upcoming_events ?? "—"} />
              <Tile label="Signups this month" value={stats?.registrations_this_month ?? "—"} />
              <Tile label="Pending / lapsed" value={`${m?.pending ?? 0} / ${m?.lapsed ?? 0}`} />
            </View>

            <Text style={s.h2}>Revenue by month</Text>
            {(stats?.revenue_by_month || []).map((r: any) => (
              <View key={r.month} style={[s.card, s.row]}>
                <Text style={s.itemTitle}>{r.month}</Text>
                <Text style={s.itemTitle}>{money(r.total_cents)}</Text>
              </View>
            ))}
            {!(stats?.revenue_by_month || []).length && (
              <Text style={s.muted}>No payments yet.</Text>
            )}

            <Pressable style={s.secondary} onPress={switchToMember}>
              <Text style={s.secondaryText}>Switch to member view</Text>
            </Pressable>
            <Pressable style={s.secondary} onPress={signOut}>
              <Text style={s.secondaryText}>Sign out</Text>
            </Pressable>
          </>
        )}

        {tab === "levels" && (
          <>
            {levels.map((l) => (
              <View key={l.id} style={s.card}>
                <View style={s.row}>
                  <Text style={s.itemTitle}>{l.name}</Text>
                  <Text style={s.itemTitle}>
                    {l.price_cents ? money(l.price_cents) : "Free"}
                  </Text>
                </View>
                {!!l.description && <Text style={s.muted}>{l.description}</Text>}
                <Text style={s.muted}>
                  {l.duration_months} months · {l.renewal_type === "auto" ? "auto-renews" : "manual renewal"}
                </Text>
              </View>
            ))}
            {!levels.length && <Text style={s.muted}>No membership levels yet.</Text>}
          </>
        )}

        {tab === "payments" && (
          <>
            {payments.slice(0, 100).map((p) => (
              <View key={p.id} style={s.card}>
                <View style={s.row}>
                  <Text style={s.itemTitle}>{money(p.amount_cents)}</Text>
                  <Text style={[s.badge, p.status === "succeeded" ? s.badgeOk : s.badgeWarn]}>
                    {p.status}
                  </Text>
                </View>
                <Text style={s.muted}>
                  {[p.first_name, p.last_name].filter(Boolean).join(" ") || p.member_email || "—"}
                </Text>
                <Text style={s.muted}>
                  {p.type} · {day(p.created_at)}
                </Text>
              </View>
            ))}
            {!payments.length && <Text style={s.muted}>No payments yet.</Text>}
          </>
        )}

        {tab === "reports" && (
          <>
            <Text style={s.h2}>{annual?.year || new Date().getFullYear()} summary</Text>
            <View style={s.tiles}>
              <Tile label="Gross revenue" value={money(annual?.revenue?.gross_cents)} />
              <Tile label="Refunded" value={money(annual?.revenue?.refunded_cents)} />
              <Tile label="Net" value={money(annual?.revenue?.net_cents)} />
              <Tile label="Members joined" value={annual?.members?.joined ?? "—"} />
              <Tile label="Events held" value={annual?.events?.count ?? "—"} />
              <Tile label="Registrations" value={annual?.events?.registrations ?? "—"} />
            </View>

            <Text style={s.h2}>Revenue by category</Text>
            {(annual?.revenue?.by_type || []).map((r: any) => (
              <View key={r.type} style={[s.card, s.row]}>
                <Text style={s.itemTitle}>{r.type}</Text>
                <Text style={s.itemTitle}>{money(r.total_cents)}</Text>
              </View>
            ))}

            <Text style={s.h2}>Top events</Text>
            {(annual?.events?.top || []).map((r: any, i: number) => (
              <View key={i} style={[s.card, s.row]}>
                <Text style={s.itemTitle}>{r.title}</Text>
                <Text style={s.muted}>{r.registrations}</Text>
              </View>
            ))}
            {!annual && <Text style={s.muted}>No report data yet.</Text>}
          </>
        )}

        {tab === "team" && (
          <>
            {team.map((t, i) => (
              <View key={i} style={s.card}>
                <View style={s.row}>
                  <Text style={s.itemTitle}>{t.name || t.email}</Text>
                  <Text style={[s.badge, s.badgeOk]}>{t.role}</Text>
                </View>
                <Text style={s.muted}>{t.email}</Text>
              </View>
            ))}
            {!team.length && <Text style={s.muted}>No team members yet.</Text>}
          </>
        )}

        {tab === "members" && (
          <>
            <TextInput
              style={s.input}
              placeholder="Search members…"
              autoCapitalize="none"
              value={query}
              onChangeText={setQuery}
            />
            <Text style={s.muted}>{filtered.length} shown</Text>
            {filtered.slice(0, 200).map((x) => (
              <View key={x.id} style={s.card}>
                <View style={s.row}>
                  <Text style={s.itemTitle}>
                    {[x.first_name, x.last_name].filter(Boolean).join(" ") || x.email}
                  </Text>
                  <Text style={[s.badge, x.status === "active" ? s.badgeOk : s.badgeWarn]}>
                    {x.status}
                  </Text>
                </View>
                <Text style={s.muted}>{x.email}</Text>
                {!!x.joined_at && <Text style={s.muted}>Joined {day(x.joined_at)}</Text>}
              </View>
            ))}
            {!filtered.length && <Text style={s.muted}>No members found.</Text>}
          </>
        )}

        {tab === "events" && (
          <>
            {events.map((ev) => (
              <View key={ev.id} style={s.card}>
                <Text style={s.itemTitle}>{ev.title}</Text>
                <Text style={s.muted}>{dayTime(ev.start_at)}</Text>
                {!!ev.location && <Text style={s.muted}>{ev.location}</Text>}
                <Text style={s.muted}>
                  {ev.capacity ? `Capacity ${ev.capacity}` : "No capacity limit"} ·{" "}
                  {ev.registration_open ? "Registration open" : "Registration closed"}
                </Text>
                <Pressable
                  style={s.primary}
                  onPress={() =>
                    router.push({
                      pathname: "/checkin",
                      params: { eventId: ev.id, tenantId: tenant.id, title: ev.title },
                    })
                  }
                >
                  <Text style={s.primaryText}>Check in attendees</Text>
                </Pressable>
              </View>
            ))}
            {!events.length && <Text style={s.muted}>No upcoming events.</Text>}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Tile({ label, value }: { label: string; value: any }) {
  return (
    <View style={s.tile}>
      <Text style={s.tileLabel}>{label}</Text>
      <Text style={s.tileValue}>{String(value)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#faf7f2" },
  center: { alignItems: "center", justifyContent: "center" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#262019",
    gap: 12,
  },
  topBarTitle: { color: "#efe7da", fontWeight: "700", fontSize: 15, flexShrink: 1 },
  switchBtn: {
    borderWidth: 1,
    borderColor: "#8a7a63",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  switchBtnText: { color: "#d9a441", fontWeight: "700", fontSize: 12 },
  tabBar: {
    flexGrow: 0,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e7dfd2",
  },
  tabBtn: { paddingHorizontal: 18, paddingVertical: 14 },
  tabLabel: { color: "#8a847a", fontWeight: "600", fontSize: 14 },
  tabLabelOn: { color: "#b5501f" },
  tabUnderline: { height: 2, backgroundColor: "#b5501f", marginTop: 8, borderRadius: 2 },
  body: { padding: 16, paddingBottom: 48 },
  guildName: { fontSize: 13, fontWeight: "700", color: "#8a847a", marginBottom: 12 },
  h1: { fontSize: 22, fontWeight: "700", color: "#221f1a", marginBottom: 12 },
  h2: { fontSize: 15, fontWeight: "700", color: "#57534b", marginTop: 12, marginBottom: 8 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    flexGrow: 1,
    minWidth: "45%",
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e7dfd2",
    borderRadius: 12,
    padding: 14,
  },
  tileLabel: { fontSize: 11, fontWeight: "700", color: "#8a847a", textTransform: "uppercase" },
  tileValue: { fontSize: 24, fontWeight: "700", color: "#221f1a", marginTop: 4 },
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e7dfd2",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  itemTitle: { fontSize: 16, fontWeight: "700", color: "#221f1a" },
  muted: { color: "#8a847a", marginTop: 4 },
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
  primary: {
    backgroundColor: "#b5501f",
    borderRadius: 8,
    paddingVertical: 12,
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
    marginTop: 16,
  },
  secondaryText: { color: "#57534b", fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: "#d6cbb8",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 16,
    backgroundColor: "#fff",
    color: "#221f1a",
    marginBottom: 10,
  },
});
