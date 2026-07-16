import { env } from "node:process";

import { defineConfig } from "wxt";

export default defineConfig({
  browser: "chrome",
  manifestVersion: 3,
  outDir: env.WXT_OUTPUT_DIR ?? ".output",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuFcnz7Nr0VcF3Do+LuucBnnowhfT2835oocq7jJYyp7Y29y7WzfLIqczNmYXVQCsJSHUPt/+ysfLBJXs2d88W4Uhg6TKj0q+Yhva8CoLJtVUet2PkGrC9Sey3Nh9LfIjCImuRFtsre3LEf9jznbG4cubXHOg5tQ+cejdjLaN56WBkuuQheFLB5Z9czygefdQBLkUq5yFvKpKNEMFx0cJeqtW1V1Ds6rcimDFeCOuWMmkYcam+AqAe2dDlTqicZSGHDhOEycSKuWSV/Y/L48phhvSKmpxShDWjfte030/rrYI99s0TwJoRkH5y/Enasfi+AwSo6r7BsT8eqyi9BalHwIDAQAB",
    default_locale: "fr",
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    minimum_chrome_version: "116",
    permissions: ["storage"],
    host_permissions: [
      "https://www.leboncoin.fr/*",
      "https://leboncoin.fr/*",
      "http://127.0.0.1/*",
    ],
    icons: {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
    action: {
      default_title: "__MSG_extensionActionTitle__",
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
