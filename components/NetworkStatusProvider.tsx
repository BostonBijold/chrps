"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { getPendingQueueCount } from "@/lib/offline-db";

// Native-only online/offline context — see docs/features/offline.md.
// Same shape as any other native-only listener in this codebase (guard
// first, dynamic import of the native-only module, listener cleanup) but
// answers a different question than Capacitor.isNativePlatform() itself:
// online vs. offline, not native vs. web.
//
// Deliberately does NOT own pull-sync/queue-flush triggering itself (the
// original design sketch had it registering an app-resume listener and
// calling pullSync directly) — this provider is mounted once at the root
// layout, before any company is resolved, so it has no companyId to sync
// with. components/TasksView.tsx (the one place that both knows companyId
// and cares about sync timing) owns its own resume/reconnect effects that
// read `isOnline` from here and call lib/offline-sync.ts directly.
interface NetworkStatusContextValue {
  isOnline: boolean;
  pendingCount: number;
  refreshPendingCount: () => void;
}

const NetworkStatusContext = createContext<NetworkStatusContextValue>({
  isOnline: true,
  pendingCount: 0,
  refreshPendingCount: () => {},
});

export function useNetworkStatus() {
  return useContext(NetworkStatusContext);
}

export default function NetworkStatusProvider({ children }: { children: ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);

  const refreshPendingCount = () => {
    if (!Capacitor.isNativePlatform()) return;
    getPendingQueueCount()
      .then(setPendingCount)
      .catch(() => {});
  };

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let removeListener: (() => void) | undefined;

    import("@capacitor/network").then(async ({ Network }) => {
      const status = await Network.getStatus();
      setIsOnline(status.connected);
      const handle = await Network.addListener("networkStatusChange", (s) => {
        setIsOnline(s.connected);
      });
      removeListener = () => handle.remove();
    });

    refreshPendingCount();

    return () => removeListener?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <NetworkStatusContext.Provider value={{ isOnline, pendingCount, refreshPendingCount }}>
      {children}
    </NetworkStatusContext.Provider>
  );
}
