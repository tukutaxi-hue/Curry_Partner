import type { ExpoConfig } from "expo/config";

const baseUrl = process.env.EXPO_BASE_URL;

const config: ExpoConfig = {
  name: "Curry Partner",
  slug: "curry-partner",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: { supportsTablet: true },
  android: {
    package: "com.currypartner.home",
    predictiveBackGestureEnabled: false,
    adaptiveIcon: {
      backgroundColor: "#F4ECDF",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
  },
  web: { favicon: "./assets/favicon.png" },
  experiments: baseUrl ? { baseUrl } : undefined,
};

export default config;
