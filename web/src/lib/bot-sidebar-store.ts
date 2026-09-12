"use client";

import { getJson } from "./client";
import type { BotDto, RoomDto } from "./types";

export type BotSidebarPreview = {
  lastMessageSummary: string | null;
  lastMessageAt: string | null;
};

export type BotSidebarBot = BotDto & BotSidebarPreview & {
  codeInProgress?: boolean;
  codeSessionCount?: number;
};

export type BotSidebarRoom = RoomDto & BotSidebarPreview;

export type BotSidebarSnapshot = {
  bots: BotSidebarBot[];
  rooms: BotSidebarRoom[];
  error: string | null;
};

const EMPTY_SNAPSHOT: BotSidebarSnapshot = {
  bots: [],
  rooms: [],
  error: null,
};

let snapshot = EMPTY_SNAPSHOT;
let signature = "";
let generation = 0;
let inFlight: Promise<BotSidebarSnapshot> | null = null;
let inFlightToken: string | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeBotSidebar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      generation += 1;
      inFlight = null;
      inFlightToken = undefined;
      snapshot = EMPTY_SNAPSHOT;
      signature = "";
    }
  };
}

export function getBotSidebarSnapshot(): BotSidebarSnapshot {
  return snapshot;
}

export function getBotSidebarServerSnapshot(): BotSidebarSnapshot {
  return EMPTY_SNAPSHOT;
}

export function refreshBotSidebar(refreshToken?: string): Promise<BotSidebarSnapshot> {
  if (inFlight && inFlightToken === refreshToken) return inFlight;

  const request = ++generation;
  const promise = getJson<{
    bots: BotSidebarBot[];
    rooms: BotSidebarRoom[];
  }>("/api/bots/sidebar", refreshToken ? { refresh: refreshToken } : undefined)
    .then((result) => {
      if (request !== generation) return snapshot;

      const nextBots = Array.isArray(result.bots) ? result.bots : [];
      const nextRooms = Array.isArray(result.rooms) ? result.rooms : [];
      const nextSignature = JSON.stringify({ bots: nextBots, rooms: nextRooms });
      if (nextSignature !== signature || snapshot.error !== null) {
        signature = nextSignature;
        snapshot = { bots: nextBots, rooms: nextRooms, error: null };
        emit();
      }
      return snapshot;
    })
    .catch((error) => {
      if (request !== generation) throw error;
      const message = error instanceof Error && error.message
        ? error.message
        : "Botとルームの読み込みに失敗しました";
      if (snapshot.error !== message) {
        snapshot = { ...snapshot, error: message };
        emit();
      }
      throw error;
    });
  inFlight = promise;
  inFlightToken = refreshToken;
  const clear = () => {
    if (inFlight === promise) {
      inFlight = null;
      inFlightToken = undefined;
    }
  };
  void promise.then(clear, clear);
  return promise;
}
