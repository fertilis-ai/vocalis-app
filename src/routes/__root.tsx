import {
  HeadContent,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Suspense, lazy, useEffect, useState } from "react";

import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import {
  applyHueOverrides,
  clearHueOverrides,
  getHueCssOverrides,
} from "@/lib/hue-presets";
import { initConfigSync, stopConfigSync } from "@/lib/config-sync";
import { initDictationHotkeySync } from "@/lib/dictation/hotkey";
import { initSettingsBroadcast, initSettingsMirror } from "@/lib/settings-broadcast";
import { initAppDataDir } from "@/lib/storage";
import { useSettingsStore } from "@/stores/settings-store";

import "../index.css";

const TanStackRouterDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-router-devtools").then((m) => ({
        default: m.TanStackRouterDevtools,
      })),
    )
  : () => null;

export type RouterAppContext = Record<string, never>;

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: "Vocalis",
      },
      {
        name: "description",
        content: "Vocalis — local-first realtime speech toolkit",
      },
    ],
  }),
});

function RootComponent() {
  const [initialized, setInitialized] = useState(false);
  const isHudWindow = getCurrentWindow().label === "hud";

  // Initialize storage directories then config.yaml sync on app start —
  // must complete before rendering children so stores never load against
  // missing directories or stale settings.
  useEffect(() => {
    let disposeHotkeySync: (() => void) | undefined;
    let disposeTrayListener: (() => void) | undefined;
    let disposeSettingsSync: (() => void) | undefined;
    let disposed = false;

    const listenForTrayChanges = () =>
      listen<{ togglePrivacy?: boolean; togglePolish?: boolean }>(
        "dictation-settings",
        ({ payload }) => {
          const settings = useSettingsStore.getState();
          if (payload.togglePrivacy) settings.setPrivacyMode(!settings.privacyMode);
          if (payload.togglePolish) {
            settings.setDictation({ polish: !settings.dictation.polish });
          }
        },
      ).then((dispose) => {
        if (disposed) dispose();
        else disposeTrayListener = dispose;
      });

    if (isHudWindow) {
      // The HUD window mirrors the main window's settings (config-sync and
      // the keychain load only run in the main window).
      disposeSettingsSync = initSettingsMirror();
      void listenForTrayChanges().finally(() => setInitialized(true));
      return () => {
        disposed = true;
        disposeTrayListener?.();
        disposeSettingsSync?.();
      };
    }

    initAppDataDir()
      .then(() => initConfigSync())
      .then(() => {
        if (disposed) return;
        disposeHotkeySync = initDictationHotkeySync();
        disposeSettingsSync = initSettingsBroadcast();
        return listenForTrayChanges();
      })
      .catch((err) => console.error("[init] Startup error:", err))
      .finally(() => setInitialized(true));
    return () => {
      disposed = true;
      disposeTrayListener?.();
      disposeHotkeySync?.();
      disposeSettingsSync?.();
      stopConfigSync();
    };
  }, [isHudWindow]);

  if (!initialized) {
    return null;
  }

  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        disableTransitionOnChange
        storageKey="vocalis-theme"
      >
        <HueApplicator />
        <div className="h-svh overflow-hidden">
          <Outlet />
        </div>
        <Toaster richColors />
      </ThemeProvider>
      {import.meta.env.DEV && (
        <Suspense fallback={null}>
          <TanStackRouterDevtools position="bottom-right" />
        </Suspense>
      )}
    </>
  );
}

function HueApplicator() {
  const hue = useSettingsStore((s) => s.hue);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const mode = resolvedTheme === "dark" ? "dark" : "light";
    const overrides = getHueCssOverrides(hue, mode);
    if (overrides) {
      applyHueOverrides(overrides);
    } else {
      clearHueOverrides();
    }
  }, [hue, resolvedTheme]);

  return null;
}
