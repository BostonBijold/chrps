"use client";

import { useEffect } from "react";
import { setStatusBarStyle } from "@/lib/native/status-bar-bridge";

// Switches the iOS status bar's time/battery/signal text to white while a
// full-bleed blue backdrop (TaskFormScreen, TaskListSessionView's summary
// receipt) is on screen, since those paint blue behind the status bar
// itself instead of this app's usual white page background. Reverts to the
// app-wide default (dark/black text, set in capacitor.config.ts) on
// unmount or once `blue` goes false again — every other screen never calls
// this and just keeps that default.
export function useStatusBarStyle(blue: boolean) {
  useEffect(() => {
    setStatusBarStyle(blue ? "blue" : "white");
    return () => {
      setStatusBarStyle("white");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blue]);
}
