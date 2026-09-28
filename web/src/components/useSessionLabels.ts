"use client";

import { useEffect, useState } from "react";
import {
  hydrateSessionLabelsFromServer,
  readSessionLabels,
  subscribeSessionLabels,
  type SessionLabel,
} from "@/lib/session-label-settings";

/** Labels live in a browser-synced setting, so read them after hydration. */
export function useSessionLabels(): SessionLabel[] {
  const [labels, setLabels] = useState<SessionLabel[]>([]);
  useEffect(() => {
    const update = () => setLabels(readSessionLabels());
    update();
    void hydrateSessionLabelsFromServer().then(update);
    return subscribeSessionLabels(update);
  }, []);
  return labels;
}
