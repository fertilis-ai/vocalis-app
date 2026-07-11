import * as React from "react";

export function usePollingLoader(loadFn: () => void, intervalMs = 5000) {
  React.useEffect(() => {
    loadFn();

    const interval = setInterval(() => {
      loadFn();
    }, intervalMs);

    return () => clearInterval(interval);
  }, [loadFn, intervalMs]);
}
