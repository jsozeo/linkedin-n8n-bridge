// Central command router. Each command receives `params` and returns the
// JSON-serializable data payload (or throws — `background.js` packages
// the error and POSTs it to /result).

import * as tab from './tab.js';
import * as navigation from './navigation.js';
import * as mouse from './mouse.js';
import * as keyboard from './keyboard.js';
import * as scroll from './scroll.js';
import * as extract from './extract.js';
import * as evaluate from './evaluate.js';
import * as screenshot from './screenshot.js';
import * as cookies from './cookies.js';
import * as social from './social.js';
import * as write from './linkedinWrite.js';
import * as registry from './registry.js';
import * as probe from './probe.js';

const handlers = {
  // Built-in
  ping: async (params = {}) => ({ ok: true, echo: params, at: Date.now() }),

  // Tabs
  open_tab:   tab.open_tab,
  close_tab:  tab.close_tab,
  list_tabs:  tab.list_tabs,
  focus_tab:  tab.focus_tab,
  get_tab:    tab.get_tab,

  // Navigation
  navigate:           navigation.navigate,
  reload:             navigation.reload,
  go_back:            navigation.go_back,
  go_forward:         navigation.go_forward,
  wait_for_load:      navigation.wait_for_load,
  wait_for_selector:  navigation.wait_for_selector,

  // Mouse / wheel
  mouse_move:  mouse.mouse_move,
  mouse_down:  mouse.mouse_down,
  mouse_up:    mouse.mouse_up,
  mouse_click: mouse.mouse_click,
  mouse_drag:  mouse.mouse_drag,
  wheel:       mouse.wheel,

  // Keyboard
  key_down:  keyboard.key_down,
  key_up:    keyboard.key_up,
  key_press: keyboard.key_press,
  type_text: keyboard.type_text,
  shortcut:  keyboard.shortcut,

  // Scroll
  scroll: scroll.scroll,

  // Extraction
  query_selector: extract.query_selector,
  get_text:       extract.get_text,
  get_html:       extract.get_html,
  get_attribute:  extract.get_attribute,
  get_value:      extract.get_value,
  exists:         extract.exists,
  count:          extract.count,

  // JS execution
  evaluate_js: evaluate.evaluate_js,

  // Screenshot
  screenshot: screenshot.screenshot,

  // Cookies
  get_cookies:   cookies.get_cookies,
  set_cookies:   cookies.set_cookies,
  clear_cookies: cookies.clear_cookies,

  // Social-media high-level extraction
  social_extract:      social.social_extract,
  list_social_skills:  social.list_social_skills,
  linkedin_extract:    social.linkedin_extract, // backwards-compatible alias

  // LinkedIn write actions — budgeted in guard.js, selectors come from the cloud registry
  linkedin_like_post:      write.linkedin_like_post,
  linkedin_like_comment:   write.linkedin_like_comment,
  linkedin_like_reply:     write.linkedin_like_reply,
  linkedin_comment_post:   write.linkedin_comment_post,
  linkedin_reply_comment:  write.linkedin_reply_comment,
  linkedin_invite:         write.linkedin_invite,

  // Cloud selector registry
  selectors_status:  registry.selectors_status,
  selectors_refresh: registry.selectors_refresh,
  selectors_set_url: registry.selectors_set_url,
  selectors_get:     registry.selectors_get,
  selectors_patch:   registry.selectors_patch,
  selectors_probe:   probe.selectors_probe,
};

export async function dispatch(type, params) {
  const fn = handlers[type];
  if (!fn) {
    const err = new Error(`Unknown command type: ${type}`);
    err.code = 'UNKNOWN_COMMAND';
    throw err;
  }
  return await fn(params || {});
}

export function listCommands() {
  return Object.keys(handlers).sort();
}
