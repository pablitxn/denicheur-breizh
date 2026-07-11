import { defineConfig } from "wxt";

export default defineConfig({
  browser: "chrome",
  manifestVersion: 3,
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Denicheur Breizh Crawler",
    description: "User-assisted real-estate extraction PoC for leboncoin.fr.",
    minimum_chrome_version: "116",
    permissions: ["storage"],
    host_permissions: ["https://www.leboncoin.fr/*", "https://leboncoin.fr/*"],
    icons: {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
    action: {
      default_title: "Denicheur Breizh",
      default_icon: {
        16: "icons/icon16.png",
        24: "icons/icon24.png",
        32: "icons/icon32.png",
      },
    },
    options_ui: {
      page: "dashboard.html",
      open_in_tab: true,
    },
  },
});
