import { z } from "zod";

// Schema for catalog.json (spec §2.5) — the Rust side bundles the same file,
// so models_catalog() results are re-validated here before hitting the UI.

export const extraFileSchema = z.object({
  url: z.string(),
  dest: z.string(),
  sha256: z.string().nullable().optional(),
});

export const catalogModelSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  name: z.string(),
  description: z.string(),
  languages: z.array(z.string()),
  sizeBytes: z.number().int().nonnegative(),
  quantization: z.string().nullable(),
  license: z.string(),
  url: z.string(),
  sha256: z.string().nullable(),
  archive: z.enum(["tar.bz2", "none"]),
  recommended: z.boolean(),
  extraFiles: z.array(extraFileSchema).optional(),
});

export const catalogSchema = z.object({
  version: z.number().int(),
  models: z.array(catalogModelSchema),
});

export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

/** models_installed() row — a model dir on disk with its real size. */
export interface InstalledModel {
  task: string;
  id: string;
  sizeBytes: number;
  /**
   * true for user-added models (spec §2.5) — no catalog entry, "Custom" badge.
   * Always present from Rust; optional here so catalog-model fixtures stay terse.
   */
  custom?: boolean;
  /** friendly name from the custom marker; null/absent for catalog models */
  name?: string | null;
}
