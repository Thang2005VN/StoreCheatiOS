// ============================================================
// FILE CAU HINH DE SUA NHANH - CHI CAN SUA CAC GIA TRI BEN DUOI
// ============================================================
window.EDITABLE_CONFIG = {
  siteName: 'CHUNG CHI STORE CHEAT iOS',
  siteTitle: 'Hệ Thống Kích Hoạt Chứng Chỉ iOS',
  botUsername: '@vanthangiosbot',
  supportText: '@ngthanhnew',

  plan50Label: '50.000Đ',
  plan50Warranty: 'Bảo hành 10 ngày',
  plan150Label: '150.000Đ',
  plan150Warranty: 'Bảo hành 365 ngày',

  bankName: 'MBBank',
  bankAccount: '2852333333',
  bankHolder: 'PHAN VAN THANG',

  appEsignName: 'ESign',
  appKsignName: 'KSign',
  appEsign2Name: 'ESign 2.0',

  paymentTimeoutMinutes: 10,
  guideTitle: 'Hướng dẫn sử dụng',
  buyButtonText: 'Mua chứng chỉ',
  lookupButtonText: 'Tra cứu UDID'
};

(function applyEditableConfig(){
  const c = window.EDITABLE_CONFIG || {};
  document.title = `${c.siteName || 'CHUNG CHI STORE CHEAT iOS'} — ${c.siteTitle || 'Hệ Thống Kích Hoạt Chứng Chỉ iOS'}`;
  const replacements = [
    ['duyle', c.siteName],
    ['50.000Đ', c.plan50Label],
    ['Bảo hành 10 ngày', c.plan50Warranty],
    ['150.000Đ', c.plan150Label],
    ['Bảo hành 365 ngày', c.plan150Warranty],
    ['ESign 2.0', c.appEsign2Name],
    ['KSign', c.appKsignName],
    ['ESign', c.appEsignName],
    ['Tra Cứu UDID', c.lookupButtonText],
    ['Mua Chứng Chỉ', c.buyButtonText]
  ].filter(x => x[1]);

  function run(){
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes=[]; while(walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      let t=n.nodeValue || '';
      for (const [a,b] of replacements) t=t.split(a).join(b);
      n.nodeValue=t;
    }
  }
  window.addEventListener('load',()=>{run();setTimeout(run,800);setTimeout(run,1800);});
})();
