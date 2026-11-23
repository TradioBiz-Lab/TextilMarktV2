// The words on the Ops & QC coordinator's screens, in English and Hindi. Only those screens: the full order page
// below the coordinator's simple top stays in English. Add a key here in BOTH languages (a test checks that).
// {name}-style markers are filled in by t().
export const COORDINATOR_TEXT = {
  en: {
    factories_title: 'Your factories',
    factories_hint: 'Tap Check in when you reach a factory.',
    no_factories: 'No factory has been given to you yet. Please ask Tradio.',
    check_in: 'Check in',
    check_out: 'Check out',
    checked_in_at: 'Checked in at {time}',
    getting_location: 'Getting your location…',
    check_out_first: 'Check out of {name} first',
    directions: 'Directions',
    no_factory_location: 'Location not added yet',
    location_title: 'Turn on location',
    location_body: 'Your phone location is needed to check in or check out. Turn on Location in the phone settings, allow it for this page, then try again.',
    location_weak: 'The phone could not find your location. Step outside or near a window and try again.',
    try_again: 'Try again',
    close: 'Close',
    visit_span: '{from} to {to} ({duration})',
    did_not_check_out: 'Did not check out',
    today: 'Today',
    bar_checked_in: 'Checked in at {name} since {time}',
    failed: 'That did not work. Please try again.',
    switch_language: 'हिंदी',
    add_home_title: 'Keep Tradio on your phone',
    add_home_body: 'Open the browser menu (the three dots) and tap "Add to Home screen". Tradio will then open like an app.',
    got_it: 'OK',
  },
  hi: {
    factories_title: 'आपकी फ़ैक्टरियाँ',
    factories_hint: 'फ़ैक्टरी पहुँचने पर चेक इन दबाएँ।',
    no_factories: 'अभी आपको कोई फ़ैक्टरी नहीं दी गई है। कृपया Tradio से पूछें।',
    check_in: 'चेक इन',
    check_out: 'चेक आउट',
    checked_in_at: '{time} बजे चेक इन किया',
    getting_location: 'आपकी लोकेशन ले रहे हैं…',
    check_out_first: 'पहले {name} से चेक आउट करें',
    directions: 'रास्ता देखें',
    no_factory_location: 'लोकेशन अभी जोड़ी नहीं गई',
    location_title: 'लोकेशन चालू करें',
    location_body: 'चेक इन या चेक आउट के लिए फ़ोन की लोकेशन ज़रूरी है। फ़ोन की सेटिंग में लोकेशन चालू करें, इस पेज को अनुमति दें, फिर दोबारा कोशिश करें।',
    location_weak: 'फ़ोन को आपकी लोकेशन नहीं मिली। बाहर या खिड़की के पास जाकर दोबारा कोशिश करें।',
    try_again: 'दोबारा कोशिश करें',
    close: 'बंद करें',
    visit_span: '{from} से {to} ({duration})',
    did_not_check_out: 'चेक आउट नहीं किया',
    today: 'आज',
    bar_checked_in: '{name} में {time} से चेक इन',
    failed: 'यह नहीं हो पाया। कृपया दोबारा कोशिश करें।',
    switch_language: 'English',
    add_home_title: 'Tradio को फ़ोन पर रखें',
    add_home_body: 'ब्राउज़र का मेनू (तीन बिंदु) खोलें और "Add to Home screen" दबाएँ। फिर Tradio ऐप की तरह खुलेगा।',
    got_it: 'ठीक है',
  },
}

export const COORDINATOR_LANGS = ['hi', 'en']
export const langOf = user => (COORDINATOR_LANGS.includes(user?.language) ? user.language : 'hi')

/** The text for `key` in `lang` (English when a key is missing), with {markers} filled from `vars`. */
export function t(key, lang = 'hi', vars = {}) {
  const s = COORDINATOR_TEXT[lang]?.[key] ?? COORDINATOR_TEXT.en[key] ?? key
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''))
}
