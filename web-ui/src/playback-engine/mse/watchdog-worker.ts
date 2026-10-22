/// <reference lib="webworker" />
/**
 * [local patch] Dedicated watchdog heartbeat.
 *
 * A wedged MSE session saturates the page's main thread, and a main-thread
 * setInterval stops firing exactly when it is needed: field logs showed zero
 * watchdog ticks across a 6s blackhole, followed by five catch-up ticks in the
 * same second once the thread freed up. This worker keeps its own timer on its
 * own thread and simply pings the page, which then runs the watchdog logic.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope;
let timer = 0;

ctx.onmessage = (event: MessageEvent<string>) => {
  if (event.data === 'start') {
    if (timer === 0) {
      timer = ctx.setInterval(() => ctx.postMessage('tick'), 100) as unknown as number;
    }
  } else if (event.data === 'stop') {
    if (timer !== 0) {
      ctx.clearInterval(timer);
      timer = 0;
    }
  }
};
