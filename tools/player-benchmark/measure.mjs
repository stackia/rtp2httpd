import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [url, output, durationArg = "60", port = "9223", setupFile] = process.argv.slice(2);
if (!url || !output)
  throw new Error("Usage: node measure.mjs <player-url> <result.json> [seconds] [CDP-port] [setup.js]");
const setupScript = setupFile ? await readFile(setupFile, "utf8") : undefined;
const duration = Number(durationArg);
if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid measurement duration");
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const logs = [];
const media = [];
let navigationStarted = Infinity;
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  } else if (message.method === "Runtime.consoleAPICalled") {
    if (message.params.timestamp < navigationStarted) return;
    logs.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
  } else if (message.method === "Runtime.exceptionThrown") {
    if (message.params.timestamp < navigationStarted) return;
    logs.push(JSON.stringify(message.params));
  } else if (message.method?.startsWith("Media.")) {
    media.push({ method: message.method, ...message.params });
  } else if (message.method === "Target.attachedToTarget") {
    void call("Runtime.enable", {}, message.params.sessionId).catch(() => {});
  }
});
const { targetInfos } = await call("Target.getTargets");
const page = targetInfos.find((target) => target.type === "page");
if (!page) throw new Error("Launch the dedicated benchmark browser with an about:blank tab first");
const { sessionId } = await call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const snapshot = () =>
  evaluate(`(() => {
  const video = [...document.querySelectorAll('video')].find(v => !v.paused) ?? document.querySelector('video');
  if (!video) return null;
  const quality = video.getVideoPlaybackQuality();
  return { time: video.currentTime, paused: video.paused, rate: video.playbackRate,
    width: video.videoWidth, height: video.videoHeight, secureContext: isSecureContext,
    visibility: document.visibilityState, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    theme: document.documentElement.className,
    preferences: Object.fromEntries(["rtp2httpd-player-auto-deinterlace", "rtp2httpd-player-picture-enhancement", "rtp2httpd-player-appearance"].map(key => [key, localStorage.getItem(key)])),
    videoRect: video.getBoundingClientRect().toJSON(), totalFrames: quality.totalVideoFrames,
    droppedFrames: quality.droppedVideoFrames, events: window.events ?? [] };
})()`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let setupIdentifier;
try {
  await call("Runtime.enable", {}, sessionId);
  await call("Page.enable", {}, sessionId);
  await call("Media.enable", {}, sessionId);
  await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  if (setupScript) {
    ({ identifier: setupIdentifier } = await call(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: setupScript },
      sessionId,
    ));
  }
  logs.length = 0;
  media.length = 0;
  navigationStarted = Date.now();
  await call("Page.navigate", { url }, sessionId);
  await sleep(20000);
  const startState = await snapshot();
  if (!startState || startState.paused || startState.time < 1) throw new Error("Playback did not start");
  const before = await call("SystemInfo.getProcessInfo");
  const start = performance.now();
  const states = [];
  for (let time = 0; time < duration; time += 5) {
    await sleep(Math.min(5, duration - time) * 1000);
    states.push(await snapshot());
  }
  const elapsed = (performance.now() - start) / 1000;
  const after = await call("SystemInfo.getProcessInfo");
  const processes = after.processInfo.map((process) => ({
    ...process,
    cpuPercent:
      ((process.cpuTime - (before.processInfo.find((p) => p.id === process.id)?.cpuTime ?? process.cpuTime)) /
        elapsed) *
      100,
  }));
  const result = {
    url,
    browser: version.Browser,
    setupScript,
    elapsed,
    startState,
    states,
    cpuBaseline: before.processInfo,
    processes,
    processChurn: {
      started: after.processInfo.filter((p) => !before.processInfo.some((b) => b.id === p.id)),
      exited: before.processInfo.filter((p) => !after.processInfo.some((a) => a.id === p.id)),
    },
    cpuPercent: processes.reduce((sum, process) => sum + process.cpuPercent, 0),
    logs,
    media,
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  if (result.processChurn.started.length || result.processChurn.exited.length) {
    throw new Error(`Browser process set changed during measurement; inspect ${output} and repeat`);
  }
  if (!logs.some((line) => line.includes("MP2 decoder initialized successfully"))) {
    throw new Error(`MP2 software decode was not verified; enable log level 4 and inspect ${output}`);
  }
  if (
    logs.some((line) => /Failed to initialize MP2|WASM stretcher unavailable|MP2 decode failed|CompileError/.test(line))
  ) {
    throw new Error(`Invalid playback run; inspect ${output} for decoder errors`);
  }
  if (media.some((event) => event.method === "Media.playerErrorsRaised" && event.errors.length > 0)) {
    throw new Error(`Media pipeline error; inspect ${output}`);
  }
  if (logs.some((line) => /Loader error|IOException|Player error:|Retrying playback/.test(line))) {
    throw new Error(`Stream failed or restarted; inspect ${output}`);
  }
  if (states.some((state) => !state || state.paused || state.visibility !== "visible")) {
    throw new Error(`Playback paused or became hidden; inspect ${output}`);
  }
  if (
    states.some((state, index) => state.time <= (index === 0 ? startState : states[index - 1]).time) ||
    states.at(-1).time <= startState.time + duration * 0.5
  ) {
    throw new Error(`Playback did not advance normally; inspect ${output}`);
  }
  console.log(
    JSON.stringify({
      output,
      cpuPercent: result.cpuPercent,
      start: startState.time,
      end: states.at(-1)?.time,
      droppedFrames: states.at(-1)?.droppedFrames - startState.droppedFrames,
    }),
  );
} finally {
  if (setupIdentifier) {
    await call("Page.removeScriptToEvaluateOnNewDocument", { identifier: setupIdentifier }, sessionId).catch(() => {});
  }
  await call("Page.navigate", { url: "about:blank" }, sessionId).catch(() => {});
  socket.close();
}
