# 视频快照（预览图）配置

rtp2httpd 支持使用 FFmpeg 来生成视频流的快照（snapshot）功能。如果播放器集成了此功能，将会获得极快的频道预览图加载速度。

## 功能特点

- **快速生成**：配合 FCC 使用时，通常在 0.3 秒内返回快照
- **自动提取关键帧**：从视频流中截取 I 帧进行转码
- **JPEG 格式**：返回标准 JPEG 图片，兼容性好
- **降低播放端压力**：无需播放器解码视频流即可显示预览图

## FFmpeg

### 安装 FFmpeg

视频快照功能依赖 FFmpeg 来提供解码能力，请先手动安装 FFmpeg。

**重要**：不要使用 OpenWrt 官方源的 `ffmpeg` 包，它阉割了 h264/hevc 编解码器，将导致无法解码视频流。

#### 推荐方法：下载静态编译版本

从 [johnvansickle.com](https://johnvansickle.com/ffmpeg/) 下载静态编译的 FFmpeg：

```bash
# 下载 FFmpeg（以 amd64 为例）
cd /tmp
wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar xf ffmpeg-release-amd64-static.tar.xz

# 复制到系统目录
sudo cp ffmpeg-*-static/ffmpeg /usr/local/bin/
sudo chmod +x /usr/local/bin/ffmpeg

# 配置 rtp2httpd 使用此 FFmpeg
# 在配置文件中设置：
# ffmpeg-path = /usr/local/bin/ffmpeg
```

## 启用视频快照

视频快照功能默认关闭，需要手动启用。

此功能对硬件有一定要求，请只考虑在性能强大的 x86 设备上启用。

### 命令行方式

```bash
rtp2httpd --video-snapshot --ffmpeg-path /usr/bin/ffmpeg --ffmpeg-args "-hwaccel none"
```

### 配置文件方式

```ini
[global]
# 启用视频快照功能
video-snapshot = yes

# FFmpeg 可执行文件路径（可选，默认: ffmpeg）
ffmpeg-path = /usr/bin/ffmpeg

# FFmpeg 额外参数（可选，默认: -hwaccel none）
ffmpeg-args = -hwaccel none
```

## 请求快照

有三种方式请求视频快照，任选一种即可：

### 方式 1：URL 查询参数

在任意流媒体 URL 后添加 `snapshot=1` 参数：

```url
http://192.168.1.1:5140/rtp/239.253.64.120:5140?snapshot=1
http://192.168.1.1:5140/CCTV-1?snapshot=1
```

### 方式 2：Accept 请求头

```bash
curl -H "Accept: image/jpeg" http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

### 方式 3：自定义请求头

```bash
curl -H "X-Request-Snapshot: 1" http://192.168.1.1:5140/rtp/239.253.64.120:5140
```

### ffmpeg-path 参数

指定 FFmpeg 可执行文件的路径。

- **默认值**：`ffmpeg`（使用系统 PATH 中的 ffmpeg）
- **使用场景**：
  - FFmpeg 不在系统 PATH 中
  - 需要使用特定版本的 FFmpeg
  - 使用自定义编译的 FFmpeg

**示例**：

```ini
[global]
ffmpeg-path = /usr/local/bin/ffmpeg
```

### ffmpeg-args 参数

指定传递给 FFmpeg 的额外参数，主要用于硬件加速配置。

- **默认值**：`-hwaccel none`（禁用硬件加速，兼容性最好）
- **常用选项**：
  - `-hwaccel none`：禁用硬件加速
  - `-hwaccel auto`：自动检测并使用硬件加速
  - `-hwaccel vaapi`：使用 VA-API 硬件加速（Intel GPU）
  - `-hwaccel v4l2m2m`：使用 V4L2 硬件加速（嵌入式 SoC）
  - `-hwaccel qsv`：使用 Intel Quick Sync Video 加速

**示例**：

```ini
[global]
# 使用 VA-API 硬件加速（Intel GPU）
ffmpeg-args = -hwaccel vaapi

# 或使用自动检测
ffmpeg-args = -hwaccel auto
```

## 硬件加速配置

### Intel GPU (VA-API)

如果你的设备有 Intel 集成显卡，可以使用 VA-API 硬件加速：

```ini
[global]
video-snapshot = yes
ffmpeg-args = -hwaccel vaapi
```

针对 Intel GPU 的预编译 FFmpeg，请参考：[rtp2httpd#37](https://github.com/stackia/rtp2httpd/issues/37)

### 嵌入式设备 (V4L2)

某些嵌入式 SoC 支持 V4L2 硬件加速：

```ini
[global]
video-snapshot = yes
ffmpeg-args = -hwaccel v4l2m2m
```

### 性能提示

- 在 CPU 性能较低的设备上，如果没有硬件加速支持，生成快照可能产生较大 CPU 占用
- 建议先使用 `-hwaccel none` 测试功能是否正常
- 确认正常后，再尝试启用硬件加速以降低 CPU 占用

## 响应时间

- **使用 FCC**：通常在 0.3 秒内返回快照（快速获取关键帧）
- **不使用 FCC**：最长约 1 秒返回（等待下一个 IDR 帧）

大多数运营商组播流每秒发送一个 IDR 帧，因此不使用 FCC 时最长需要等待 1 秒。

## 播放器集成建议

如果你是播放器开发者，建议按以下方式集成预览图功能：

1. **请求快照时带上自定义请求头**：

   ```http
   GET /rtp/239.253.64.120:5140 HTTP/1.1
   X-Request-Snapshot: 1
   ```

2. **根据响应的 Content-Type 决定处理方式**：

   - 如果响应 `Content-Type: image/jpeg`：直接渲染 JPEG 图片
   - 如果响应其他类型：说明服务器不支持快照，尝试解码媒体流

3. **兼容性**：这种方式可以同时兼容 rtp2httpd 和其他不支持快照的流媒体服务器

## 故障排查

### 快照请求返回视频流而不是图片

可能的原因：

1. **未启用 video-snapshot**：检查配置文件或命令行参数
2. **FFmpeg 不可用**：检查 FFmpeg 是否正确安装
3. **FFmpeg 解码失败**：查看 rtp2httpd 日志

### FFmpeg 解码失败

可能的原因：

1. **编解码器缺失**：OpenWrt 官方源的 FFmpeg 缺少 h264/hevc 编解码器
2. **硬件加速不支持**：尝试改用 `-hwaccel none`
3. **硬件忙**：有些硬件解码器，同时解码的媒体流有上限，并发请求过多时可能出现硬件忙碌错误。

### CPU 占用过高

- 禁用硬件加速后 CPU 占用高是正常现象
- 解决方案：
  1. 使用硬件加速（如果设备支持）
  2. 减少同时请求快照的客户端数量
  3. 在播放器设置中降低预览图请求并发数

## 相关文档

- [URL 格式说明](url-formats.md)：快照 URL 格式
- [配置参数详解](configuration.md)：视频快照相关配置
- [FCC 快速换台配置](fcc-setup.md)：配合 FCC 获得更快的快照速度
