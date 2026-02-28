import { defineConfig } from "vitepress";

export default defineConfig({
	title: "rtp2httpd",
	description: "IPTV 流媒体转发服务器",
	lang: "zh-CN",
	cleanUrls: true,

	themeConfig: {
		logo: "/icon.svg",

		nav: [{ text: "文档", link: "/quick-start" }],

		sidebar: [
			{
				text: "入门",
				items: [
					{ text: "快速上手", link: "/quick-start" },
					{ text: "安装方式", link: "/installation" },
				],
			},
			{
				text: "使用指南",
				items: [
					{ text: "URL 格式说明", link: "/url-formats" },
					{ text: "M3U 播放列表集成", link: "/m3u-integration" },
					{ text: "内置 Web 播放器", link: "/web-player" },
					{ text: "配置参数详解", link: "/configuration" },
				],
			},
			{
				text: "高级功能",
				items: [
					{ text: "FCC 快速换台配置", link: "/fcc-setup" },
					{ text: "公网访问建议", link: "/public-access" },
					{ text: "时间处理说明", link: "/time-processing" },
					{ text: "视频快照配置", link: "/video-snapshot" },
				],
			},
			{
				text: "参考资料",
				items: [
					{ text: "性能测试报告", link: "/benchmark" },
					{ text: "各地 FCC 地址汇总", link: "/cn-fcc-collection" },
				],
			},
		],

		socialLinks: [{ icon: "github", link: "https://github.com/stackia/rtp2httpd" }],
	},
});
