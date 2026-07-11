import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/mocks/tauri"));

import { invoke, isTauri } from "@tauri-apps/api/core";
import { deleteApiKey, getApiKey, loadAllApiKeys, storeApiKey } from "./keychain";

const mockInvoke = vi.mocked(invoke);
const mockIsTauri = vi.mocked(isTauri);

describe("keychain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("in the browser", () => {
    beforeEach(() => {
      mockIsTauri.mockReturnValue(false);
    });

    it("all operations are no-ops that never invoke", async () => {
      await storeApiKey("openai", "sk-123");
      await deleteApiKey("openai");
      expect(await getApiKey("openai")).toBe("");
      expect(await loadAllApiKeys()).toEqual({});
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("on desktop", () => {
    beforeEach(() => {
      mockIsTauri.mockReturnValue(true);
    });

    it("storeApiKey invokes store_api_key", async () => {
      mockInvoke.mockResolvedValue(undefined);
      await storeApiKey("deepgram", "dg-1");
      expect(mockInvoke).toHaveBeenCalledWith("store_api_key", {
        provider: "deepgram",
        key: "dg-1",
      });
    });

    it("getApiKey maps a missing key (null) to empty string", async () => {
      mockInvoke.mockResolvedValue(null);
      expect(await getApiKey("groq")).toBe("");
      expect(mockInvoke).toHaveBeenCalledWith("get_api_key", { provider: "groq" });
    });

    it("getApiKey returns the stored key", async () => {
      mockInvoke.mockResolvedValue("el-key");
      expect(await getApiKey("elevenlabs")).toBe("el-key");
    });

    it("loadAllApiKeys returns the provider map", async () => {
      mockInvoke.mockResolvedValue({ openai: "sk-1" });
      expect(await loadAllApiKeys()).toEqual({ openai: "sk-1" });
      expect(mockInvoke).toHaveBeenCalledWith("get_all_api_keys");
    });
  });
});
