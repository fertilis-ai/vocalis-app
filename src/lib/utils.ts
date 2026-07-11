import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n... (truncated, ${text.length} total chars)`;
}

export function createSingleton<T>(factory: () => T, cleanup?: (instance: T) => void) {
  let instance: T | null = null;
  return {
    get(): T {
      if (!instance) {
        instance = factory();
      }
      return instance;
    },
    reset(): void {
      if (instance && cleanup) {
        cleanup(instance);
      }
      instance = null;
    },
  };
}
