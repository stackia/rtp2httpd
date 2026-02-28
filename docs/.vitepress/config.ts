import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

export default defineConfig({
	vite: {
		plugins: [llmstxt({ ignoreFiles: ["en/**/*"] })], // Keep only Chinese content (which is source of truth) for LLM
	},

	title: "rtp2httpd",
	cleanUrls: true,
	head: [["link", { rel: "icon", href: "/icon.svg", type: "image/svg+xml" }]],

	sitemap: {
		hostname: "https://rtp2httpd.com",
	},

	locales: {
		root: {
			label: "简体中文",
			lang: "zh-CN",
			description: "IPTV 流媒体转发服务器",
			themeConfig: {
				nav: [{ text: "文档", link: "/guide/quick-start" }],

				sidebar: [
					{
						text: "入门",
						items: [
							{ text: "快速上手", link: "/guide/quick-start" },
							{ text: "安装方式", link: "/guide/installation" },
						],
					},
					{
						text: "使用指南",
						items: [
							{ text: "URL 格式说明", link: "/guide/url-formats" },
							{ text: "M3U 播放列表集成", link: "/guide/m3u-integration" },
							{ text: "内置 Web 播放器", link: "/guide/web-player" },
						],
					},
					{
						text: "高级功能",
						items: [
							{ text: "FCC 快速换台配置", link: "/guide/fcc-setup" },
							{ text: "公网访问建议", link: "/guide/public-access" },
							{ text: "时间处理说明", link: "/guide/time-processing" },
							{ text: "视频快照配置", link: "/guide/video-snapshot" },
						],
					},
					{
						text: "参考资料",
						items: [
							{ text: "配置参数详解", link: "/reference/configuration" },
							{ text: "各地 FCC 地址汇总", link: "/reference/cn-fcc-collection" },
							{ text: "性能测试报告", link: "/reference/benchmark" },
							{ text: "相关教程和软件", link: "/reference/related-resources" },
						],
					},
				],

				editLink: {
					pattern: "https://github.com/stackia/rtp2httpd/edit/main/docs/:path",
					text: "在 GitHub 上编辑此页",
				},

				footer: {
					message: "基于 GPL-2.0 许可证发布",
					copyright: "版权所有 © 2023-至今 Stackie Jia",
				},

				docFooter: {
					prev: "上一页",
					next: "下一页",
				},

				outline: {
					label: "页面导航",
				},

				lastUpdated: {
					text: "最后更新于",
				},

				notFound: {
					title: "页面未找到",
					quote: "但如果你不改变方向，并且继续寻找，你可能最终会到达你所前往的地方。",
					linkLabel: "前往首页",
					linkText: "带我回首页",
				},

				langMenuLabel: "多语言",
				returnToTopLabel: "回到顶部",
				sidebarMenuLabel: "菜单",
				darkModeSwitchLabel: "主题",
				lightModeSwitchTitle: "切换到浅色模式",
				darkModeSwitchTitle: "切换到深色模式",
				skipToContentLabel: "跳转到内容",
			},
		},
		en: {
			label: "English",
			lang: "en-US",
			description: "IPTV Streaming Media Forwarding Server",
			themeConfig: {
				nav: [{ text: "Docs", link: "/en/guide/quick-start" }],

				sidebar: [
					{
						text: "Getting Started",
						items: [
							{ text: "Quick Start", link: "/en/guide/quick-start" },
							{ text: "Installation", link: "/en/guide/installation" },
						],
					},
					{
						text: "Usage Guide",
						items: [
							{ text: "URL Formats", link: "/en/guide/url-formats" },
							{ text: "M3U Playlist Integration", link: "/en/guide/m3u-integration" },
							{ text: "Built-in Web Player", link: "/en/guide/web-player" },
						],
					},
					{
						text: "Advanced Features",
						items: [
							{ text: "Fast Channel Change", link: "/en/guide/fcc-setup" },
							{ text: "Public Access", link: "/en/guide/public-access" },
							{ text: "Time Processing", link: "/en/guide/time-processing" },
							{ text: "Video Snapshot", link: "/en/guide/video-snapshot" },
						],
					},
					{
						text: "Reference",
						items: [
							{ text: "Configuration", link: "/en/reference/configuration" },
							{ text: "CN FCC Address Collection", link: "/en/reference/cn-fcc-collection" },
							{ text: "Benchmark", link: "/en/reference/benchmark" },
							{ text: "Related Resources", link: "/en/reference/related-resources" },
						],
					},
				],

				editLink: {
					pattern: "https://github.com/stackia/rtp2httpd/edit/main/docs/:path",
					text: "Edit this page on GitHub",
				},

				footer: {
					message: "Released under the GPL-2.0 License.",
					copyright: "Copyright © 2023-present Stackie Jia",
				},
			},
		},
	},

	themeConfig: {
		logo: "/icon.svg",
		socialLinks: [{ icon: "github", link: "https://github.com/stackia/rtp2httpd" }],
		search: {
			provider: "algolia",
			options: {
				appId: "WFCUQFWIYE",
				apiKey: "5ea4c13bbf1296239ae1c79273d3c4cd",
				indexName: "rtp2httpd",
				locales: {
					root: {
						translations: {
							button: {
								buttonText: "搜索",
								buttonAriaLabel: "搜索",
							},
							modal: {
								searchBox: {
									clearButtonTitle: "清除",
									clearButtonAriaLabel: "清除查询",
									closeButtonText: "关闭",
									closeButtonAriaLabel: "关闭",
									placeholderText: "搜索文档",
									placeholderTextAskAi: "再问一个问题...",
									placeholderTextAskAiStreaming: "正在回答...",
									searchInputLabel: "搜索",
									backToKeywordSearchButtonText: "返回关键词搜索",
									backToKeywordSearchButtonAriaLabel: "返回关键词搜索",
									newConversationPlaceholder: "提问",
									conversationHistoryTitle: "我的对话历史",
									startNewConversationText: "开始新的对话",
									viewConversationHistoryText: "对话历史",
									threadDepthErrorPlaceholder: "对话已达上限",
								},
								newConversation: {
									newConversationTitle: "我今天能帮你什么？",
									newConversationDescription: "我会搜索你的文档，快速帮你找到设置指南、功能细节和故障排除提示。",
								},
								footer: {
									selectText: "选择",
									submitQuestionText: "提交问题",
									selectKeyAriaLabel: "回车键",
									navigateText: "导航",
									navigateUpKeyAriaLabel: "向上箭头",
									navigateDownKeyAriaLabel: "向下箭头",
									closeText: "关闭",
									backToSearchText: "返回搜索",
									closeKeyAriaLabel: "Esc 键",
									poweredByText: "搜索提供商",
								},
								errorScreen: {
									titleText: "无法获取结果",
									helpText: "你可能需要检查网络连接。",
								},
								startScreen: {
									recentSearchesTitle: "最近",
									noRecentSearchesText: "暂无最近搜索",
									saveRecentSearchButtonTitle: "保存此搜索",
									removeRecentSearchButtonTitle: "从历史记录中移除此搜索",
									favoriteSearchesTitle: "收藏",
									removeFavoriteSearchButtonTitle: "从收藏中移除此搜索",
									recentConversationsTitle: "最近对话",
									removeRecentConversationButtonTitle: "从历史记录中移除此对话",
								},
								noResultsScreen: {
									noResultsText: "未找到相关结果",
									suggestedQueryText: "尝试搜索",
									reportMissingResultsText: "认为此查询应该有结果？",
									reportMissingResultsLinkText: "告诉我们。",
								},
								resultsScreen: {
									askAiPlaceholder: "询问 AI：",
									noResultsAskAiPlaceholder: "文档里没找到？让 Ask AI 帮忙：",
								},
								askAiScreen: {
									disclaimerText: "回答由 AI 生成，可能会出错。请核实。",
									relatedSourcesText: "相关来源",
									thinkingText: "思考中...",
									copyButtonText: "复制",
									copyButtonCopiedText: "已复制！",
									copyButtonTitle: "复制",
									likeButtonTitle: "喜欢",
									dislikeButtonTitle: "不喜欢",
									thanksForFeedbackText: "感谢你的反馈！",
									preToolCallText: "搜索中...",
									duringToolCallText: "搜索中...",
									afterToolCallText: "已搜索",
									stoppedStreamingText: "你已停止此回复",
									errorTitleText: "聊天错误",
									threadDepthExceededMessage: "为保持回答准确，此对话已关闭。",
									startNewConversationButtonText: "开始新的对话",
								},
							},
						},
					},
				},
			},
		},
	},
});
