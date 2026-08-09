"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration({ basePath }: { basePath: string }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const serviceWorkerUrl = `${basePath}/sw.js`.replace(/^\/\//, "/");
    void navigator.serviceWorker.register(serviceWorkerUrl, {
      scope: `${basePath || ""}/`,
      updateViaCache: "none",
    }).catch(() => {
      // Offline support is progressive enhancement; editor persistence must not
      // depend on service-worker availability or registration success.
    });
  }, [basePath]);

  return null;
}
