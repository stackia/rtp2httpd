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

  // Errors
  failedToLoadPlaylist: "Failed to load playlist",
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

  // Player controls
  play: "Play",
  pause: "Pause",
  mute: "Mute",
  unmute: "Unmute",
  fullscreen: "Fullscreen",
  exitFullscreen: "Exit Fullscreen",
  pictureInPicture: "Picture in Picture",
  exitPictureInPicture: "Exit Picture in Picture",

  // Relative dates
  today: "Today",
  yesterday: "Yesterday",
  tomorrow: "Tomorrow",
  dayBeforeYesterday: "2 days ago",

  // Settings
  settings: "Settings",
  language: "Language",
  theme: "Theme",
  themeAuto: "Auto",
  themeLight: "Light",
  themeDark: "Dark",
  catchupTailOffset: "Catchup Tail Offset",
  catchupTailOffsetHint: "0 means current time, in seconds",
  force16x9: "Force 16:9",
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

  // 错误信息
  failedToLoadPlaylist: "加载播放列表失败",
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

  // 播放器控制
  play: "播放",
  pause: "暂停",
  mute: "静音",
  unmute: "取消静音",
  fullscreen: "全屏",
  exitFullscreen: "退出全屏",
  pictureInPicture: "画中画",
  exitPictureInPicture: "退出画中画",

  // 相对日期
  today: "今天",
  yesterday: "昨天",
  tomorrow: "明天",
  dayBeforeYesterday: "前天",

  // 设置
  settings: "设置",
  language: "语言",
  theme: "主题",
  themeAuto: "自动",
  themeLight: "浅色",
  themeDark: "深色",
  catchupTailOffset: "回看切片尾偏移",
  catchupTailOffsetHint: "0 表示当前，单位秒",
  force16x9: "强制 16:9",
};

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
  autoplayBlocked: "瀏覽器需要使用者互動才能開始播放",

  // 錯誤訊息
  failedToLoadPlaylist: "載入播放清單失敗",
  noCatchupSupport: "此頻道不支援回看功能",
  noRewindSupport: "此頻道不支援時移功能",
  codecError: "不支援的視訊/音訊編碼。您的瀏覽器無法解碼此串流。",
  mseNotSupported: "您的瀏覽器不支援 MSE (媒體來源擴充)",
  mediaError: "媒體錯誤",
  networkError: "網路錯誤",
  failedToPlay: "播放失敗",

  // 時移按鈕
  rewind30m: "-30分鐘",
  rewind1h: "-1小時",
  rewind3h: "-3小時",

  // 時間格式
  minutes: "分鐘",

  // 進度條
  live: "直播",

  // 播放器控制
  play: "播放",
  pause: "暫停",
  mute: "靜音",
  unmute: "取消靜音",
  fullscreen: "全螢幕",
  exitFullscreen: "退出全螢幕",
  pictureInPicture: "子母畫面",
  exitPictureInPicture: "退出子母畫面",

  // 相對日期
  today: "今天",
  yesterday: "昨天",
  tomorrow: "明天",
  dayBeforeYesterday: "前天",

  // 設置
  settings: "設定",
  language: "語言",
  theme: "主題",
  themeAuto: "自動",
  themeLight: "淺色",
  themeDark: "深色",
  catchupTailOffset: "回看切片尾偏移",
  catchupTailOffsetHint: "0 表示當前，單位秒",
  force16x9: "強制 16:9",
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
