import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";

function isEnglishPath(path: string) {
	return path.startsWith("/en/") || path === "/en";
}

export default {
	...DefaultTheme,
	enhanceApp({ router }) {
		if (typeof window === "undefined") return;

		// Track user's explicit language choice when they switch languages
		let currentIsEnglish = isEnglishPath(window.location.pathname);
		router.onAfterRouteChange = (to: string) => {
			const nowIsEnglish = isEnglishPath(to);
			if (currentIsEnglish !== nowIsEnglish) {
				localStorage.setItem("preferred-lang", nowIsEnglish ? "en" : "zh");
			}
			currentIsEnglish = nowIsEnglish;
		};

		// Determine preferred language: explicit choice > browser detection
		const saved = localStorage.getItem("preferred-lang");
		const prefersEnglish = saved ? saved === "en" : !navigator.language?.startsWith("zh");

		const path = window.location.pathname;
		if (prefersEnglish && !currentIsEnglish) {
			router.go(`/en${path}`);
		} else if (!prefersEnglish && currentIsEnglish) {
			router.go(path.replace(/^\/en\/?/, "/") || "/");
		}
	},
} satisfies Theme;
