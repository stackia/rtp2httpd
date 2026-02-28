import { defineConfig } from "vitepress";

export default defineConfig({
	title: "rtp2httpd",
	cleanUrls: true,
	head: [["link", { rel: "icon", href: "/icon.svg", type: "image/svg+xml" }]],

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
					quote: "如果你不改变方向，继续寻找，你可能最终会到达你要去的地方。",
					linkLabel: "返回首页",
					linkText: "返回首页",
				},

				footer: {
					message: "基于 GPL-2.0 许可证发布",
					copyright: "Copyright © 2023-present Stackie Jia",
				},
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
	},
});
