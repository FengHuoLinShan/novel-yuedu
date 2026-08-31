// 广告/统计域名列表（service worker 通过 importScripts 加载）
// 用途：
//  1. background 在阅读模式打开时，按当前站点注册 declarativeNetRequest 会话规则（仅该站生效）
//  2. rules/dnr-blocklist.json 由 tools/gen_dnr.py 从本列表生成（全局静态规则，默认关闭，可在 popup 开启）
// 注意：只放确定性高的广告联盟与统计域名，不放可能影响正常站点功能的大厂主域
self.AD_DOMAINS = [
  // 国际广告联盟
  "doubleclick.net",
  "googlesyndication.com",
  "adservice.google.com",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "smartadserver.com",
  "taboola.com",
  "outbrain.com",
  "mgid.com",
  "revcontent.com",
  "propellerads.com",
  "popads.net",
  "popcash.net",
  "hilltopads.net",
  "exoclick.com",
  "zedo.com",
  "infolinks.com",
  "adform.net",
  "adsrvr.org",
  "teads.tv",
  "sharethrough.com",
  "quantserve.com",
  "scorecardresearch.com",
  // 统计/埋点
  "google-analytics.com",
  "googletagmanager.com",
  "analytics.google.com",
  "hotjar.com",
  // 国内广告联盟与统计（笔趣阁系弹窗广告的主要来源）
  "pos.baidu.com",
  "cpro.baidu.com",
  "eclick.baidu.com",
  "cnzz.com",
  "umeng.com",
  "umengcloud.com",
  "51.la",
  "51yes.com",
  "talkingdata.com",
  "miaozhen.com",
  "admaster.com.cn"
];
