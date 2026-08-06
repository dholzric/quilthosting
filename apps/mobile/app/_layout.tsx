import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#faf7f2" },
          headerTintColor: "#b5501f",
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: "#faf7f2" },
        }}
      >
        <Stack.Screen name="index" options={{ title: "QuiltHosting" }} />
        <Stack.Screen name="member" options={{ title: "Member" }} />
        <Stack.Screen name="admin" options={{ title: "Admin" }} />
        <Stack.Screen name="checkin" options={{ title: "Event check-in" }} />
      </Stack>
    </>
  );
}
