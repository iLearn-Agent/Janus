import { iconSvg } from '../ui/icons.js';

export function renderJanusApp() {
  return `<div class="view janus-app-view" data-page-kind="janus-app" role="region" aria-labelledby="janus-app-page-title">
    <header class="janus-app-header">
      <div>
        <span class="janus-app-mark" aria-hidden="true"><img src="../../assets/icons/icon.png" alt="" /></span>
        <div><h1 id="janus-app-page-title">Janus App</h1><p>移动端正在准备中</p></div>
      </div>
      <span class="janus-app-status">即将推出</span>
    </header>
    <section class="janus-app-stage" aria-label="Janus 移动端">
      <div class="janus-app-copy">
        <span>JANUS MOBILE</span>
        <h2>Janus，随时在手边</h2>
        <p>iOS 与 Android 版本将在准备就绪后公布。</p>
        <div class="janus-app-platforms" aria-label="移动端平台">
          <span>${iconSvg('smartphone')}<strong>iOS</strong><em>准备中</em></span>
          <span>${iconSvg('smartphone')}<strong>Android</strong><em>准备中</em></span>
        </div>
      </div>
      <div class="janus-app-device" aria-hidden="true">
        <div class="janus-app-device-screen">
          <div class="janus-app-dynamic-island"><i></i></div>
          <div class="janus-app-device-splash">
            <img src="../../assets/icons/icon.png" alt="" />
            <strong>Janus</strong>
            <small>Mobile</small>
          </div>
          <span class="janus-app-home-indicator"></span>
        </div>
      </div>
    </section>
  </div>`;
}
