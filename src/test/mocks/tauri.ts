import { vi } from "vitest";

// Shared mock for @tauri-apps/api/core
// Usage: vi.mock("@tauri-apps/api/core", () => import("@/test/mocks/tauri"))

export const invoke = vi.fn();
export const isTauri = vi.fn(() => false);
