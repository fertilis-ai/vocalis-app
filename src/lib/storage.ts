import { invoke, isTauri } from "@tauri-apps/api/core";

// All app data lives under ~/.vocalis/ — see spec/spec.md §4.
// The desktop backend owns directory creation; in a plain browser (vitest,
// storybook-style dev) these are no-ops.

export function isDesktop(): boolean {
  return isTauri();
}

export async function initAppDataDir(): Promise<void> {
  if (!isDesktop()) return;
  await invoke("init_app_data_dir");
}

export async function getAppDataDir(): Promise<string | null> {
  if (!isDesktop()) return null;
  return invoke<string>("get_app_data_dir");
}

export async function readFile(path: string): Promise<string> {
  if (!isDesktop()) return "";
  return invoke<string>("read_file", { path });
}

export async function writeFile(path: string, content: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("write_file", { path, content });
}

/** Read a file's raw bytes (used to upload audio to API engines). */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  if (!isDesktop()) return new Uint8Array();
  const base64 = await invoke<string>("read_file_base64", { path });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Write raw bytes to a file (used to persist API-synthesized audio). */
export async function writeFileBytes(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  if (!isDesktop()) return;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  await invoke("write_file_base64", { path, dataBase64: btoa(binary) });
}

export async function pathExists(path: string): Promise<boolean> {
  if (!isDesktop()) return false;
  return invoke<boolean>("path_exists", { path });
}

export async function deletePath(path: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("delete_path", { path });
}

export async function renamePath(oldPath: string, newPath: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("rename_path", { oldPath, newPath });
}

export async function copyFile(sourcePath: string, destPath: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("copy_file", { sourcePath, destPath });
}

export async function createDirectory(path: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("create_directory", { path });
}

export async function revealInFolder(path: string): Promise<void> {
  if (!isDesktop()) return;
  await invoke("reveal_in_folder", { path });
}

export async function listFiles(dir: string, extension?: string): Promise<string[]> {
  if (!isDesktop()) return [];
  return invoke<string[]>("list_files", { dir, extension: extension ?? null });
}

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

/** Read a directory tree. Returns [] in a browser or if the dir is missing. */
export async function readDirectory(
  dir: string,
  maxDepth?: number,
): Promise<FileNode[]> {
  if (!isDesktop()) return [];
  try {
    return await invoke<FileNode[]>("read_directory", {
      path: dir,
      maxDepth: maxDepth ?? null,
    });
  } catch {
    return [];
  }
}
