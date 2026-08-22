import type { PlayerEventMap, PlayerSegment } from "../types";

export function resolveMediaUrl(url: string): string {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

export function resolveSegmentUrls(segments: PlayerSegment[]): PlayerSegment[] {
  return segments.map((segment) => ({ ...segment, url: resolveMediaUrl(segment.url) }));
}

export function createPlaybackEventEmitter() {
  const handlers = new Map<keyof PlayerEventMap, Set<PlayerEventMap[keyof PlayerEventMap]>>();

  function getHandlers<EventName extends keyof PlayerEventMap>(event: EventName): Set<PlayerEventMap[EventName]> {
    let eventHandlers = handlers.get(event) as Set<PlayerEventMap[EventName]> | undefined;
    if (!eventHandlers) {
      eventHandlers = new Set<PlayerEventMap[EventName]>();
      handlers.set(event, eventHandlers as Set<PlayerEventMap[keyof PlayerEventMap]>);
    }
    return eventHandlers;
  }

  function emit<EventName extends keyof PlayerEventMap>(
    event: EventName,
    ...args: Parameters<PlayerEventMap[EventName]>
  ): void {
    for (const handler of getHandlers(event)) {
      (handler as (...values: Parameters<PlayerEventMap[EventName]>) => void)(...args);
    }
  }

  return {
    emit,
    getHandlers,
    on<EventName extends keyof PlayerEventMap>(event: EventName, handler: PlayerEventMap[EventName]) {
      getHandlers(event).add(handler);
    },
    off<EventName extends keyof PlayerEventMap>(event: EventName, handler: PlayerEventMap[EventName]) {
      getHandlers(event).delete(handler);
    },
    clear: () => handlers.clear(),
  };
}
