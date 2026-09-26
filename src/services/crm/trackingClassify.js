const { CLASSIFIER_VERSION } = require('./trackingConfig');

const BOT = /(bot|spider|crawler|preview|facebookexternalhit|whatsapp|slackbot|twitterbot|linkedinbot|embedly|pinterest|skypeuripreview|vkshare|w3c_validator|lighthouse|headless)/i;

function coarse(ua) {
  const text = String(ua || '');
  const browser = /edg\//i.test(text) ? 'edge'
    : /chrome|crios/i.test(text) ? 'chrome'
      : /safari/i.test(text) && !/chrome/i.test(text) ? 'safari'
        : /firefox|fxios/i.test(text) ? 'firefox'
          : 'unknown';
  const platform = /android/i.test(text) ? 'android'
    : /iphone|ipad|ios/i.test(text) ? 'ios'
      : /windows/i.test(text) ? 'windows'
        : /mac os/i.test(text) ? 'mac'
          : 'unknown';
  const device = /ipad|tablet/i.test(text) ? 'tablet'
    : /mobile|iphone|android/i.test(text) ? 'phone'
      : text ? 'desktop' : 'unknown';
  return { browser_class: browser, platform_class: platform, device_class: device };
}

function referrerOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin.slice(0, 200);
  } catch {
    return null;
  }
}

function classifyOpen({ userAgent, purpose, method }) {
  const classes = coarse(userAgent);
  const purposeText = String(purpose || '').toLowerCase();
  if (method && String(method).toUpperCase() === 'HEAD') {
    return { ...classes, event_class: 'PREVIEW', countable: false, classifier_version: CLASSIFIER_VERSION };
  }
  if (purposeText.includes('prefetch') || purposeText.includes('preview')) {
    return { ...classes, event_class: 'PREVIEW', countable: false, classifier_version: CLASSIFIER_VERSION };
  }
  if (!String(userAgent || '').trim()) {
    return { ...classes, event_class: 'UNKNOWN', countable: false, classifier_version: CLASSIFIER_VERSION };
  }
  if (BOT.test(String(userAgent))) {
    return { ...classes, event_class: 'BOT', countable: false, classifier_version: CLASSIFIER_VERSION };
  }
  return { ...classes, event_class: 'QUALIFIED', countable: true, classifier_version: CLASSIFIER_VERSION };
}

module.exports = { classifyOpen, referrerOrigin, coarse };
