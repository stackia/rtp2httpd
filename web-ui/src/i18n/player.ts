import type { Locale } from "../lib/locale";

type TranslationDict = Record<string, string>;

const base: TranslationDict = {
  // Page title and headers
  title: "rtp2httpd Player",
  error: "Error",
  retry: "Retry",

  // Header controls
  hideSidebar: "Hide Sidebar",
  showSidebar: "Show Sidebar",
  goLive: "Go Live",

  // Sidebar tabs
  channels: "Channels",
  programGuide: "Program Guide",

  // Channel list
  searchChannels: "Search channels...",
  allChannels: "All",
  catchup: "Catchup",
  catchupSupported: "Catchup supported",

  // EPG view
  noEpgAvailable: "No program guide available for this channel",
  onAir: "On Air",
  replay: "Replay",
  nowPlaying: "Now Playing",
  excellentProgram: "Excellent Program",

  // Video player
  selectChannelToWatch: "Select a channel to start watching",
  loadingVideo: "Loading...",
  playbackError: "Playback Error",
  clickToPlay: "Click to Play",
  autoplayBlocked: "Browser requires user interaction to start playback",
  playingInPictureInPicture: "Video is playing in Picture-in-Picture",

  // Errors
  failedToLoadPlaylist: "Failed to load playlist",
  emptyPlaylist: "No playable channels were found in the playlist",
  playlistLoadEyebrow: "M3U playlist",
  playlistLoadTitle: "Playlist is not ready yet",
  playlistLoadDescription:
    "The Player loads channels from /playlist.m3u, but the playlist is unavailable right now. Configure an M3U playlist, then retry.",
  playlistErrorChecklist: "Check your M3U setup",
  playlistErrorHintReachable: "Make sure the external M3U URL is reachable by rtp2httpd.",
  playlistErrorHintFormat: "Confirm the playlist contains valid #EXTINF entries and channel URLs.",
  m3uIntegrationGuide: "View M3U setup guide",
  playlistEndpoint: "Playlist endpoint",
  technicalDetails: "Technical details",
  noCatchupSupport: "This channel does not support catchup playback",
  noRewindSupport: "This channel does not support rewind",
  codecError: "Unsupported video/audio codec. Your browser cannot decode this stream.",
  mseNotSupported: "Your browser does not support MSE (Media Source Extensions)",
  mediaError: "Media error",
  networkError: "Network error",
  failedToPlay: "Failed to play",

  // Rewind buttons
  rewind30m: "-30m",
  rewind1h: "-1h",
  rewind3h: "-3h",

  // Time format (for screen readers and accessibility)
  minutes: "min",

  // Progress bar
  live: "LIVE",
  seekTo: "Seek to position",

  // Player controls
  play: "Play",
  pause: "Pause",
  mute: "Mute",
  unmute: "Unmute",
  fullscreen: "Fullscreen",
  exitFullscreen: "Exit Fullscreen",
  pictureInPicture: "Picture in Picture",

  // Relative dates
  today: "Today",
  yesterday: "Yesterday",
  tomorrow: "Tomorrow",
  dayBeforeYesterday: "2 days ago",

  // Source selector
  source: "Source",
  sourceFallback: "Trying next source...",

  // Settings
  settings: "Settings",
  language: "Language",
  theme: "Theme",
  themeAuto: "Auto",
  themeLight: "Light",
  themeDark: "Dark",
  seamlessSwitch: "Seamless switch",
  videoProcessing: "Video Processing",
  resolutionLimitHint: "1080p and below only",
  deinterlace: "Auto Deinterlacing",
  pictureEnhancement: "Picture Enhancement",
};

const zhHans: TranslationDict = {
  // 页面标题和头部
  title: "rtp2httpd 播放器",
  error: "错误",
  retry: "重试",

  // 头部控制
  hideSidebar: "隐藏侧边栏",
  showSidebar: "显示侧边栏",
  goLive: "返回直播",

  // 侧边栏标签
  channels: "频道",
  programGuide: "节目单",

  // 频道列表
  searchChannels: "搜索频道...",
  allChannels: "全部",
  catchup: "回看",
  catchupSupported: "支持回看",

  // EPG 视图
  noEpgAvailable: "此频道暂无节目单",
  onAir: "直播中",
  replay: "回放",
  nowPlaying: "正在播放",
  excellentProgram: "精彩节目",

  // 视频播放器
  selectChannelToWatch: "选择一个频道开始观看",
  loadingVideo: "加载中...",
  playbackError: "播放错误",
  clickToPlay: "点击播放",
  autoplayBlocked: "浏览器需要用户交互才能开始播放",
  playingInPictureInPicture: "视频正在画中画模式下播放",

  // 错误信息
  failedToLoadPlaylist: "加载播放列表失败",
  emptyPlaylist: "播放列表中没有可播放频道",
  playlistLoadEyebrow: "M3U 播放列表",
  playlistLoadTitle: "播放列表还没有准备好",
  playlistLoadDescription:
    "播放器会从 /playlist.m3u 加载频道，但当前无法获取播放列表。请先配置 M3U 播放列表，然后重试。",
  playlistErrorChecklist: "请检查 M3U 配置",
  playlistErrorHintReachable: "确认外部 M3U 地址可以被 rtp2httpd 正常访问。",
  playlistErrorHintFormat: "确认播放列表包含有效的 #EXTINF 条目和频道地址。",
  m3uIntegrationGuide: "查看 M3U 配置指南",
  playlistEndpoint: "播放列表地址",
  technicalDetails: "错误详情",
  noCatchupSupport: "此频道不支持回看功能",
  noRewindSupport: "此频道不支持时移功能",
  codecError: "不支持的视频/音频编码。您的浏览器无法解码此流。",
  mseNotSupported: "您的浏览器不支持 MSE (媒体源扩展)",
  mediaError: "媒体错误",
  networkError: "网络错误",
  failedToPlay: "播放失败",

  // 时移按钮
  rewind30m: "-30分钟",
  rewind1h: "-1小时",
  rewind3h: "-3小时",

  // 时间格式
  minutes: "分钟",

  // 进度条
  live: "直播",
  seekTo: "跳转到指定位置",

  // 播放器控制
  play: "播放",
  pause: "暂停",
  mute: "静音",
  unmute: "取消静音",
  fullscreen: "全屏",
  exitFullscreen: "退出全屏",
  pictureInPicture: "画中画",

  // 相对日期
  today: "今天",
  yesterday: "昨天",
  tomorrow: "明天",
  dayBeforeYesterday: "前天",

  // 线路选择
  source: "线路",
  sourceFallback: "正在尝试下一线路...",

  // 设置
  settings: "设置",
  language: "语言",
  theme: "主题",
  themeAuto: "自动",
  themeLight: "浅色",
  themeDark: "深色",
  seamlessSwitch: "无缝换台",
  videoProcessing: "画质处理",
  resolutionLimitHint: "仅 1080P 及以下生效",
  deinterlace: "自动反交错",
  pictureEnhancement: "画质增强",
};

// 繁體中文（偏好香港用語）
const zhHant: TranslationDict = {
  // 頁面標題和頭部
  title: "rtp2httpd - 播放器",
  error: "錯誤",
  retry: "重試",

  // 頭部控制
  hideSidebar: "隱藏側邊欄",
  showSidebar: "顯示側邊欄",
  goLive: "返回直播",

  // 側邊欄標籤
  channels: "頻道",
  programGuide: "節目表",

  // 頻道列表
  searchChannels: "搜尋頻道...",
  allChannels: "全部",
  catchup: "回看",
  catchupSupported: "支援回看",

  // EPG 視圖
  noEpgAvailable: "此頻道暫無節目表",
  onAir: "直播中",
  replay: "重播",
  nowPlaying: "正在播放",
  excellentProgram: "精彩節目",

  // 視訊播放器
  selectChannelToWatch: "選擇一個頻道開始觀看",
  loadingVideo: "載入中...",
  playbackError: "播放錯誤",
  clickToPlay: "點擊播放",
  autoplayBlocked: "瀏覽器需要用戶互動才能開始播放",
  playingInPictureInPicture: "影片正在畫中畫模式下播放",

  // 錯誤訊息
  failedToLoadPlaylist: "載入播放列表失敗",
  emptyPlaylist: "播放列表中沒有可播放頻道",
  playlistLoadEyebrow: "M3U 播放列表",
  playlistLoadTitle: "播放列表尚未準備好",
  playlistLoadDescription:
    "播放器會從 /playlist.m3u 載入頻道，但目前無法取得播放列表。請先配置 M3U 播放列表，然後重試。",
  playlistErrorChecklist: "請檢查 M3U 配置",
  playlistErrorHintReachable: "確認外部 M3U 地址可以被 rtp2httpd 正常存取。",
  playlistErrorHintFormat: "確認播放列表包含有效的 #EXTINF 條目和頻道地址。",
  m3uIntegrationGuide: "查看 M3U 配置指南",
  playlistEndpoint: "播放列表地址",
  technicalDetails: "錯誤詳情",
  noCatchupSupport: "此頻道不支援回看功能",
  noRewindSupport: "此頻道不支援時移功能",
  codecError: "不支援的視頻/音頻編碼。您的瀏覽器無法解碼此串流。",
  mseNotSupported: "您的瀏覽器不支援 MSE (媒體來源擴展)",
  mediaError: "媒體錯誤",
  networkError: "網絡錯誤",
  failedToPlay: "播放失敗",

  // 時移按鈕
  rewind30m: "-30分鐘",
  rewind1h: "-1小時",
  rewind3h: "-3小時",

  // 時間格式
  minutes: "分鐘",

  // 進度條
  live: "直播",
  seekTo: "跳轉到指定位置",

  // 播放器控制
  play: "播放",
  pause: "暫停",
  mute: "靜音",
  unmute: "取消靜音",
  fullscreen: "全屏",
  exitFullscreen: "退出全屏",
  pictureInPicture: "畫中畫",

  // 相對日期
  today: "今天",
  yesterday: "昨天",
  tomorrow: "明天",
  dayBeforeYesterday: "前天",

  // 線路選擇
  source: "線路",
  sourceFallback: "正在嘗試下一線路...",

  // 設置
  settings: "設定",
  language: "語言",
  theme: "主題",
  themeAuto: "自動",
  themeLight: "淺色",
  themeDark: "深色",
  seamlessSwitch: "無縫換台",
  videoProcessing: "畫質處理",
  resolutionLimitHint: "僅 1080P 及以下生效",
  deinterlace: "自動反交錯",
  pictureEnhancement: "畫質增強",
};

export const translations: Record<Locale, TranslationDict> = {
  en: base,
  "zh-Hans": { ...base, ...zhHans },
  "zh-Hant": { ...base, ...zhHant },
};

export type TranslationKey = keyof typeof base;

export function translate(locale: Locale, key: TranslationKey): string {
  return translations[locale][key] ?? base[key];
}
