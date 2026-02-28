import { defineConfig } from "vitepress";

export default defineConfig({
	title: "rtp2httpd",
	description: "IPTV 流媒体转发服务器",
	lang: "zh-CN",
	cleanUrls: true,
	head: [["link", { rel: "icon", href: "/icon.svg", type: "image/svg+xml" }]],

	themeConfig: {
		logo: "/icon.svg",

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

		socialLinks: [{ icon: "github", link: "https://github.com/stackia/rtp2httpd" }],

		footer: {
			message: "Released under the GPL-2.0 License.",
			copyright: "Copyright © 2023-present Stackie Jia",
		},
	},
});
