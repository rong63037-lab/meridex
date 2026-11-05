import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MERIDEX 美瑞德",
    short_name: "MERIDEX",
    description: "多资产现货沙盒：贵金属、加密货币、大宗商品、外汇",
    start_url: "/",
    display: "standalone",
    background_color: "#07080A",
    theme_color: "#07080A",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
