<script setup lang="ts">
import { useData, withBase } from "vitepress";
import "./sponsor.css";

const { lang } = useData();
</script>

<template>
  <aside v-if="lang === 'zh-CN'" class="home-sponsor" aria-label="赞助方 · Token Unlimited">
    <a
      class="home-sponsor__card"
      href="https://token-unlimited.com/?utm_source=rtp2httpd&utm_medium=display&utm_campaign=2026_sept_promo&utm_content=doc_site_banner"
      target="_blank"
      rel="sponsored noopener noreferrer"
    >
      <div class="home-sponsor__brand">
        <span class="home-sponsor__label">赞助方</span>
        <div class="home-sponsor__identity">
          <img :src="withBase('/token-unlimited.png')" width="36" height="36" alt="" />
          <span class="home-sponsor__wordmark">Token Unlimited</span>
        </div>
      </div>

      <div class="home-sponsor__copy">
        <h2>满血模型，普惠价格。</h2>
        <p class="home-sponsor__source">来自 Azure OpenAI 模型服务，低至官方价格的 0.4 折</p>
      </div>

      <div class="home-sponsor__art" aria-hidden="true">
        <svg class="home-sponsor__infinity" viewBox="0 0 480 260" fill="none">
          <defs>
            <linearGradient id="sponsor-ribbon" x1="50" y1="65" x2="425" y2="210" gradientUnits="userSpaceOnUse">
              <stop stop-color="#2179ec" />
              <stop offset=".48" stop-color="#8791f5" />
              <stop offset="1" stop-color="#4bb9bb" />
            </linearGradient>
            <linearGradient id="sponsor-edge" x1="70" y1="40" x2="390" y2="220" gradientUnits="userSpaceOnUse">
              <stop stop-color="#8ec9ff" />
              <stop offset="1" stop-color="#d4eeff" />
            </linearGradient>
          </defs>
          <path d="M240 130C199 76 166 48 122 48C67 48 36 84 36 130C36 176 67 212 122 212C166 212 199 184 240 130C281 76 314 48 358 48C413 48 444 84 444 130C444 176 413 212 358 212C314 212 281 184 240 130Z" stroke="url(#sponsor-ribbon)" stroke-width="35" />
          <path d="M240 130C199 76 166 48 122 48C67 48 36 84 36 130C36 176 67 212 122 212C166 212 199 184 240 130C281 76 314 48 358 48C413 48 444 84 444 130C444 176 413 212 358 212C314 212 281 184 240 130Z" stroke="url(#sponsor-edge)" stroke-width="1.5" opacity=".7" />
        </svg>
      </div>
      <span class="home-sponsor__link" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
    </a>
  </aside>
</template>
