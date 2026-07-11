import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SectionId =
  | "chat"
  | "playground"
  | "voices"
  | "models"
  | "settings"
  | "debug";

interface PaneWidths {
  chat: number;
  playground: number;
  voices: number;
  models: number;
  settings: number;
  debug: number;
}

interface LayoutState {
  openSection: SectionId | null;
  paneWidths: PaneWidths;

  toggleSection: (section: SectionId) => void;
  openSectionPane: (section: SectionId) => void;
  closePane: () => void;
  setPaneWidth: (section: SectionId, width: number) => void;
}

const DEFAULT_PANE_WIDTHS: PaneWidths = {
  chat: 250,
  playground: 250,
  voices: 250,
  models: 250,
  settings: 300,
  debug: 250,
};

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      openSection: null,
      paneWidths: DEFAULT_PANE_WIDTHS,

      toggleSection: (section) => {
        const { openSection } = get();
        if (openSection === section) {
          set({ openSection: null });
        } else {
          set({ openSection: section });
        }
      },

      openSectionPane: (section) => {
        set({ openSection: section });
      },

      closePane: () => {
        set({ openSection: null });
      },

      setPaneWidth: (section, width) => {
        set((state) => ({
          paneWidths: {
            ...state.paneWidths,
            [section]: width,
          },
        }));
      },
    }),
    {
      name: "vocalis-layout",
      partialize: (state) => ({
        paneWidths: state.paneWidths,
      }),
    },
  ),
);
