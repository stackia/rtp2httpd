# 播放器性能测量

使用真实 MPEG-TS 录制片段按 PCR 时钟回放，比较播放器整个浏览器进程组的 CPU 时间。测试页使用正式 MSE playback backend，启用 MP2 WASM 软解、关闭画质增强和反交错，不引入仅在安全上下文可用的 API。普通局域网 HTTP 地址可直接测试。

## 构建和回放

先录制至少两分钟的真实节目。保留原始 TS 字节，不转码。录制文件需要包含 PCR，并使用 188 字节 TS 包。录像不应提交进仓库。

```sh
curl 'http://your-server/path/to/channel' --max-time 180 -o /tmp/program.ts
node tools/player-benchmark/build.mjs /tmp/player-bench/current
node tools/player-benchmark/serve.mjs /tmp/player-bench /tmp/program.ts 8766
```

`curl` 在直播录制达到 `--max-time` 时以超时结束属正常情况；仍需检查文件有效。用 `ffprobe` 确认分辨率、扫描方式和 MP2 音轨。

打开 `http://localhost:8766/current/tools/player-benchmark/index.html`。异机 HTTP 验证时将 localhost 换成服务器的局域网地址。`source` 查询参数可以指定真实直播地址，例如 `?source=<URL-encoded-stream-url>`。默认播放同源 `/stream`，每次连接都从同一段节目开头按原 PCR 节奏回放。`/stream?speed=1.2` 可提供持续追直播的输入速率。

对修改前后版本分别构建到不同目录，再由同一个回放服务提供。不要让两个播放器同时运行。

## 测量浏览器 CPU

使用独立浏览器用户目录，避免把日常标签页和插件计入结果。例如 macOS Chrome：

```sh
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --user-data-dir=/tmp/player-bench-chrome --remote-debugging-port=9223 \
  --no-first-run --no-default-browser-check \
  --autoplay-policy=no-user-gesture-required \
  --disable-background-networking --disable-component-update \
  --window-size=1280,720 about:blank

node tools/player-benchmark/measure.mjs \
  http://localhost:8766/current/tools/player-benchmark/index.html \
  /tmp/player-result.json 60
```

脚本预热 20 秒后，累计浏览器、渲染器（含 worker）、GPU、网络和音频服务进程的 CPU 时间，100% 表示占满一个逻辑 CPU。它同时保存实际播放时间、丢帧数、可见状态、音轨/视频解码器信息及播放器日志。检查是否真实播放、MP2 是否启用、是否走同一种视频解码路径，再比较 CPU。采用 A/B/B/A 顺序并保持窗口大小、可见性、节目片段和测量区间一致。

脚本要求日志中出现 MP2 解码器初始化成功。播放重连、媒体错误、时钟倒退、页面隐藏或进程集合变化会令测量失败；失败轮次不应计入对比。完整播放器页面需要开启日志（当前页面默认已开启），关闭画质增强和反交错，并在两版使用相同外观。也可以将以下内容保存为 `/tmp/player-setup.js`，作为脚本第五个参数传入；它会在页面初始化前执行，并随测量结果保存：

```js
localStorage.setItem("rtp2httpd-player-auto-deinterlace", "false");
localStorage.setItem("rtp2httpd-player-picture-enhancement", "false");
localStorage.setItem("rtp2httpd-player-appearance", "fancy");
```

```sh
node tools/player-benchmark/measure.mjs \
  http://your-server/player.html /tmp/full-player.json 60 9223 /tmp/player-setup.js
```

**采样剖析与 CPU 对比应分开运行。** DevTools CPU profiler 本身会增加开销。不能把 JavaScript 采样占比、单函数加速比、渲染器 CPU 或服务器 CPU 当成整页 CPU 降幅。启动丢帧和稳定测量区间内的丢帧也应分开统计。

## 定位局部开销

解复用/封装基准会测试不同网络分块尺寸，并输出媒体及 MP2 数据的 SHA-256；对相同输入，修改前后的摘要必须一致：

```sh
node tools/player-benchmark/build.mjs /tmp/player-demux demux
node /tmp/player-demux/demux-benchmark.js /tmp/program.ts
```

WSOLA 基准需要 48 kHz、双声道 float32 PCM。下面仅转换音频测试输入，不用于整页回放：

```sh
ffmpeg -i /tmp/program.ts -t 30 -vn -ar 48000 -ac 2 -f f32le /tmp/program.f32
node tools/player-benchmark/wasm-benchmark.mjs /tmp/program.f32 \
  /tmp/baseline.wasm web-ui/src/playback-engine/wasm/minimp3/mp2_decoder.wasm
```

它在 1×、0.9×、1.01×、1.2×、2× 下测量，并断言输出逐字节一致。使用正式基线构建中的 WASM 文件。单元测试另覆盖不同采样率、单/双声道、细碎输入、静音、变速后的时长/音调及 reset。

## 已验证的取舍

- 穷举 WSOLA 搜索保留所有候选位置；同时计算八个相邻候选，保持每个相关性累加和并列结果的顺序。避免通过缩小搜索范围或抽样来换取速度和音质损失。
- TS 头直接从输入缓冲区读取，减少每包临时视图、对象和闭包；仍保留 188/192/204 字节包处理、PCR 回绕和 discontinuity 标记。
- 拉伸结果同步写入 AudioBuffer，使用借用的 WASM 视图，省去中间 PCM 复制。不可在下次 process 后保留该视图。
- 保留 MSE 静音音轨、现有音画同步、变速、后台恢复和 HTTP 支持。移除静音音轨会影响后台播放，不能只为 CPU 数字取消。
- 控件隐藏时停止直播圆点动画，避免不可见动画持续唤醒合成器；鼠标/触摸显示控件以及键盘聚焦时恢复动画，保留玻璃外观。
- 测过 SIMD 构建和更大的展开宽度；额外收益很小且增加兼容分支或代码量，未采用。测试更大的 Web Audio latency hint 后未发现可靠的整页收益，也未改变默认延迟。

本次真实节目与测量数据见 [results.md](results.md)。
