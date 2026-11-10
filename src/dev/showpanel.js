// Geliştirici: UDT ile yüklenince paneli otomatik gösterir (gerçek panel ekran görüntüsü / test için).
// src/dev .ccx paketine girmez → kurulu eklentide bu kod yoktur.
"use strict";
module.exports = function showPanel() {
  try {
    const pm = require("uxp").pluginManager;
    for (const p of pm.plugins) if (p.id === "com.mangaceviri.studio" && p.showPanel) p.showPanel("mainPanel");
    return true;
  } catch (e) { return false; }
};
